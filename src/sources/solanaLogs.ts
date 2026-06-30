import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import { config } from "../config.js";
import { makeLogger } from "../util/logger.js";
import { getWsAgent } from "../net/proxy.js";
import { base58Encode } from "../util/base58.js";
import type { PumpEvent } from "../types.js";

const log = makeLogger("solana-logs");

/** pump.fun program id. */
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

/** Anchor event discriminators = sha256("event:<Name>")[..8]. */
const disc = (name: string) =>
  createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
const CREATE_DISC = disc("CreateEvent");
const TRADE_DISC = disc("TradeEvent");

/** Derive the websocket URL from the configured HTTP RPC URL. */
function wssUrl(): string {
  const u = config.solanaRpcUrl;
  if (u.startsWith("https://")) return "wss://" + u.slice(8);
  if (u.startsWith("http://")) return "ws://" + u.slice(7);
  return u;
}

/** Borsh reader over a Buffer. */
class Reader {
  off = 0;
  constructor(private buf: Buffer) {}
  u8() {
    return this.buf.readUInt8(this.off++);
  }
  u32() {
    const v = this.buf.readUInt32LE(this.off);
    this.off += 4;
    return v;
  }
  u64() {
    const v = this.buf.readBigUInt64LE(this.off);
    this.off += 8;
    return v;
  }
  i64() {
    const v = this.buf.readBigInt64LE(this.off);
    this.off += 8;
    return v;
  }
  pubkey() {
    const b = this.buf.subarray(this.off, this.off + 32);
    this.off += 32;
    return base58Encode(b);
  }
  string() {
    const len = this.u32();
    const s = this.buf.toString("utf8", this.off, this.off + len);
    this.off += len;
    return s;
  }
}

/**
 * Alternative realtime feed that bypasses pump.fun's own API: it subscribes to
 * the pump.fun *program logs* directly over the Solana RPC websocket and decodes
 * the Anchor CreateEvent / TradeEvent records. Useful when pumpportal.fun is
 * blocked from your VPN exit but a Solana RPC (Helius recommended) is reachable.
 *
 * Drop-in compatible with PumpPortal: same events + watch methods.
 */
export class SolanaLogsFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private alive = false;
  private subscribedTokens = new Set<string>();
  private subscribedWallets = new Set<string>();
  private lastMsgAt = 0;
  /** if no data arrives for this long, the subscription has gone silent → reconnect */
  private static STALE_MS = 60_000;

  start() {
    this.connect();
    // watchdog: pump.fun is high-volume, so a long silence means the
    // subscription stalled (RPC throttle / silent drop). Force a reconnect.
    setInterval(() => {
      if (this.alive && this.lastMsgAt && Date.now() - this.lastMsgAt > SolanaLogsFeed.STALE_MS) {
        log.warn("no data for 60s — subscription stalled, reconnecting…");
        this.lastMsgAt = Date.now();
        try {
          this.ws?.close();
        } catch {
          /* will reconnect on close */
        }
      }
    }, 20_000).unref();
  }

  private connect() {
    const url = wssUrl();
    log.info("connecting", url.replace(/api-key=[^&]+/, "api-key=***"));
    const agent = getWsAgent();
    const ws = agent
      ? new WebSocket(url, { agent } as ConstructorParameters<typeof WebSocket>[2])
      : new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.alive = true;
      this.reconnectDelay = 1000;
      this.lastMsgAt = Date.now();
      log.ok("connected — subscribing to pump.fun program logs");
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "logsSubscribe",
          params: [{ mentions: [PUMP_PROGRAM] }, { commitment: "confirmed" }],
        }),
      );
    });

    ws.on("message", (raw) => this.onMessage(raw.toString()));
    ws.on("close", () => {
      this.alive = false;
      log.warn(`disconnected, retrying in ${this.reconnectDelay}ms`);
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    });
    ws.on("error", (e) => log.error("ws error:", (e as Error).message));
  }

  private onMessage(text: string) {
    this.lastMsgAt = Date.now();
    let msg: {
      method?: string;
      result?: unknown;
      params?: { result?: { value?: { signature?: string; err?: unknown; logs?: string[] } } };
    };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg.result === "number") {
      log.ok(`subscription active (id ${msg.result})`);
      return;
    }
    if (msg.method !== "logsNotification") return;
    const value = msg.params?.result?.value;
    if (!value || value.err) return; // skip failed txs
    const sig = value.signature;
    for (const line of value.logs ?? []) {
      if (!line.startsWith("Program data: ")) continue;
      this.decode(line.slice(14), sig);
    }
  }

  private decode(b64: string, signature?: string) {
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, "base64");
    } catch {
      return;
    }
    if (buf.length < 8) return;
    const head = buf.subarray(0, 8);
    try {
      if (head.equals(CREATE_DISC)) this.onCreate(buf.subarray(8), signature);
      else if (head.equals(TRADE_DISC)) this.onTrade(buf.subarray(8), signature);
    } catch {
      /* malformed record — skip */
    }
  }

  private onCreate(body: Buffer, signature?: string) {
    const r = new Reader(body);
    const name = r.string();
    const symbol = r.string();
    r.string(); // uri (unused)
    const mint = r.pubkey();
    r.pubkey(); // bonding curve (unused)
    const user = r.pubkey();
    const ev: PumpEvent = {
      mint,
      txType: "create",
      traderPublicKey: user,
      name,
      symbol,
      signature,
      receivedAt: Date.now(),
    };
    this.emit("newToken", ev);
  }

  private onTrade(body: Buffer, signature?: string) {
    const r = new Reader(body);
    const mint = r.pubkey();
    const solAmount = r.u64();
    const tokenAmount = r.u64();
    const isBuy = r.u8() === 1;
    const user = r.pubkey();
    r.i64(); // timestamp
    const vSol = r.u64();
    const vTok = r.u64();

    const marketCapSol = vTok > 0n ? (Number(vSol) / Number(vTok)) * 1e6 : undefined;
    const ev: PumpEvent = {
      mint,
      txType: isBuy ? "buy" : "sell",
      traderPublicKey: user,
      solAmount: Number(solAmount) / 1e9,
      tokenAmount: Number(tokenAmount) / 1e6,
      marketCapSol,
      signature,
      receivedAt: Date.now(),
    };
    if (this.subscribedTokens.has(mint)) this.emit("trade", ev);
    if (this.subscribedWallets.has(user)) this.emit("walletTrade", ev);
  }

  // ---- same watch interface as PumpPortal (we already receive everything,
  //      so these just gate which trades we forward) ----
  watchToken(mint: string) {
    this.subscribedTokens.add(mint);
  }
  unwatchToken(mint: string) {
    this.subscribedTokens.delete(mint);
  }
  watchWallet(wallet: string) {
    this.subscribedWallets.add(wallet);
  }
  unwatchWallet(wallet: string) {
    this.subscribedWallets.delete(wallet);
  }
}
