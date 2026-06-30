import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { config } from "../config.js";
import { makeLogger } from "../util/logger.js";
import type { PumpEvent, TxType } from "../types.js";

const log = makeLogger("pumpportal");

/**
 * Realtime feed of pump.fun activity.
 *
 * Emits:
 *   "newToken" (PumpEvent)   — a brand new token was created
 *   "trade"    (PumpEvent)   — a buy/sell on a token we subscribed to
 *   "walletTrade" (PumpEvent)— a trade by a wallet we subscribed to
 */
export class PumpPortal extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private subscribedTokens = new Set<string>();
  private subscribedWallets = new Set<string>();
  private alive = false;

  start() {
    this.connect();
  }

  private connect() {
    log.info("connecting", config.pumpPortalWsUrl);
    const ws = new WebSocket(config.pumpPortalWsUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.alive = true;
      this.reconnectDelay = 1000;
      log.ok("connected");
      this.send({ method: "subscribeNewToken" });
      // re-arm any subscriptions we had before a reconnect
      if (this.subscribedTokens.size)
        this.send({ method: "subscribeTokenTrade", keys: [...this.subscribedTokens] });
      if (this.subscribedWallets.size)
        this.send({ method: "subscribeAccountTrade", keys: [...this.subscribedWallets] });
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

  private send(obj: unknown) {
    if (this.ws && this.alive) this.ws.send(JSON.stringify(obj));
  }

  private onMessage(text: string) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    // PumpPortal sends a {message:"..."} ack for subscriptions — skip those.
    if (typeof msg.mint !== "string") return;

    const txType = String(msg.txType ?? "").toLowerCase() as TxType;
    const ev: PumpEvent = {
      mint: msg.mint as string,
      txType: (["create", "buy", "sell"].includes(txType) ? txType : "buy") as TxType,
      traderPublicKey: msg.traderPublicKey as string | undefined,
      solAmount: num(msg.solAmount),
      tokenAmount: num(msg.tokenAmount),
      marketCapSol: num(msg.marketCapSol),
      name: msg.name as string | undefined,
      symbol: msg.symbol as string | undefined,
      pool: msg.pool as string | undefined,
      signature: msg.signature as string | undefined,
      receivedAt: Date.now(),
    };

    if (ev.txType === "create") {
      this.emit("newToken", ev);
    } else {
      if (this.subscribedTokens.has(ev.mint)) this.emit("trade", ev);
      if (ev.traderPublicKey && this.subscribedWallets.has(ev.traderPublicKey))
        this.emit("walletTrade", ev);
    }
  }

  watchToken(mint: string) {
    if (this.subscribedTokens.has(mint)) return;
    this.subscribedTokens.add(mint);
    this.send({ method: "subscribeTokenTrade", keys: [mint] });
  }

  unwatchToken(mint: string) {
    if (!this.subscribedTokens.delete(mint)) return;
    this.send({ method: "unsubscribeTokenTrade", keys: [mint] });
  }

  watchWallet(wallet: string) {
    if (this.subscribedWallets.has(wallet)) return;
    this.subscribedWallets.add(wallet);
    this.send({ method: "subscribeAccountTrade", keys: [wallet] });
  }

  unwatchWallet(wallet: string) {
    if (!this.subscribedWallets.delete(wallet)) return;
    this.send({ method: "unsubscribeAccountTrade", keys: [wallet] });
  }
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
