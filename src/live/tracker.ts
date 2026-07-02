import { EventEmitter } from "node:events";
import { config } from "../config.js";
import { makeLogger } from "../util/logger.js";
import { store } from "../store/store.js";
import type { Alert, Analysis, PositionDTO, PumpEvent } from "../types.js";

const log = makeLogger("tracker");

interface PosState {
  mint: string;
  symbol?: string;
  name?: string;
  url?: string | null;
  verdict: Analysis["verdict"];
  score: number;
  openedAt: number;
  entryMcap: number | null;
  peakMcap: number;
  lastMcap: number;
  topHolders: Set<string>;
  stopLossPct: number;
  trailingStopPct: number;
  firstTpMult: number;
  breakevenArmed: boolean;
  entered: boolean;
  exited: boolean;
  entryAlerted: boolean;
  lastWarnAt: number;
  lastAccumAt: number;
  /** rolling (t, mcap) for sudden-dump detection */
  window: { t: number; mcap: number }[];
  /** per-wallet SOL in/out on this token, for smart-money auto-discovery */
  flows: Map<string, { buy: number; sell: number }>;
}

const WARN_COOLDOWN_MS = 20_000;
const ACCUM_COOLDOWN_MS = 30_000;
const DUMP_WINDOW_MS = 20_000;

/**
 * Live position tracker.
 *
 * For every token the engine decides is worth watching, we follow its realtime
 * trade stream (from PumpPortal — no extra API quota) and:
 *
 *   ENTRY  → a whale or tracked smart-money wallet BUYS  ("get in when the
 *            real pumpers buy").
 *   EXIT   → the big/real holders or smart money SELL, a sudden dump prints,
 *            the trailing stop trips, or the stop-loss hits  ("get out the
 *            moment the whales start dumping").
 *
 * Emits:
 *   "alert" (Alert)   — push to Telegram / dashboard
 *   "drop"  (mint)    — tell the engine to unsubscribe this token
 */
export class Tracker extends EventEmitter {
  private positions = new Map<string, PosState>();

  start() {
    setInterval(() => this.evictStale(), 30_000).unref();
  }

  /** Begin tracking a token using the analysis we just produced. */
  open(a: Analysis) {
    const existing = this.positions.get(a.mint);
    if (existing) {
      // refresh the grade, and if this re-grade is a conviction signal, arm the
      // exit triggers on the already-tracked position (it used to stay dormant).
      existing.verdict = a.verdict;
      existing.score = a.score;
      if (a.conviction && !existing.entered) {
        existing.entered = true;
        existing.entryAlerted = true;
        existing.entryMcap ??=
          existing.lastMcap > 0 ? existing.lastMcap : (a.bundleFacts?.earlyMarketCapSol ?? null);
      }
      return;
    }
    if (this.positions.size >= config.live.trackMaxTokens) this.evictOldest();

    // All live prices come from the trade stream's `marketCapSol`. Start the
    // peak/last at 0 so the FIRST trade seeds them in the right unit — never mix
    // DexScreener's USD market-cap with the stream's SOL market-cap.
    this.positions.set(a.mint, {
      mint: a.mint,
      symbol: a.symbol,
      name: a.name,
      url: a.marketFacts?.url ?? null,
      verdict: a.verdict,
      score: a.score,
      openedAt: Date.now(),
      peakMcap: 0,
      lastMcap: 0,
      topHolders: new Set((a.holderFacts?.topHolders ?? []).map((h) => h.owner)),
      stopLossPct: a.exit.stopLossPct,
      trailingStopPct: a.exit.trailingStopPct,
      firstTpMult: a.exit.takeProfits[0]?.multiple ?? 1.5,
      breakevenArmed: false,
      // a conviction token IS the entry signal → mark it entered so exit
      // triggers (dump / smart-sell / trailing / stop) arm immediately.
      entered: a.conviction,
      entryMcap: a.conviction ? (a.bundleFacts?.earlyMarketCapSol ?? null) : null,
      exited: false,
      entryAlerted: a.conviction,
      lastWarnAt: 0,
      lastAccumAt: 0,
      window: [],
      flows: new Map(),
    });
    log.debug(`tracking ${a.symbol ?? a.mint.slice(0, 8)} (${this.positions.size} live)`);
  }

  isTracking(mint: string) {
    return this.positions.has(mint);
  }

  /** current live market cap (SOL) of a tracked token, for entry references */
  liveMcapOf(mint: string): number | null {
    return this.positions.get(mint)?.lastMcap ?? null;
  }

  /**
   * Arm the exit triggers for a token the user says they're in (the sell path
   * ignores tokens we never "entered"). Called when someone taps "I'm in".
   */
  markEntered(mint: string): boolean {
    const p = this.positions.get(mint);
    if (!p || p.exited) return false;
    p.entered = true;
    p.entryAlerted = true;
    if (p.entryMcap == null && p.lastMcap > 0) p.entryMcap = p.lastMcap;
    return true;
  }

  /** Feed a realtime trade for a tracked token. */
  onTrade(ev: PumpEvent) {
    const p = this.positions.get(ev.mint);
    if (!p || p.exited) return;

    const mcap = ev.marketCapSol ?? p.lastMcap;
    p.lastMcap = mcap;
    if (mcap > p.peakMcap) p.peakMcap = mcap;
    // an entered position restored after a restart has no entry reference yet —
    // seed it from the first live trade so stop/trailing/break-even can compute
    if (p.entered && p.entryMcap == null && mcap > 0) p.entryMcap = mcap;
    // arm the break-even stop once the first take-profit level is reached
    if (p.entered && p.entryMcap && mcap >= p.entryMcap * p.firstTpMult) p.breakevenArmed = true;
    const now = ev.receivedAt;
    p.window.push({ t: now, mcap });
    while (p.window.length && now - p.window[0].t > DUMP_WINDOW_MS) p.window.shift();

    const trader = ev.traderPublicKey;
    const smart = trader ? store.isSmart(trader) : undefined;
    const sol = ev.solAmount ?? 0;

    // record SOL in/out per wallet so we can auto-discover profitable traders
    if (trader && sol > 0) {
      const f = p.flows.get(trader) ?? { buy: 0, sell: 0 };
      if (ev.txType === "buy") f.buy += sol;
      else f.sell += sol;
      p.flows.set(trader, f);
    }

    if (ev.txType === "buy") {
      // ENTRY = the best setups only: a tracked smart-money wallet buying, OR a
      // real whale buying a token that PASSED safety (not AVOID). No tiny buys,
      // no top-holder pings, no accumulation spam, one ENTRY per token.
      const isWhaleBuy = sol >= config.live.whaleBuySol;
      const qualifies = smart || (isWhaleBuy && p.verdict !== "AVOID");
      if (qualifies && !p.entryAlerted) {
        p.entered = true;
        p.entryAlerted = true;
        p.entryMcap = mcap;
        this.fire(p, {
          kind: "ENTRY",
          terminal: false,
          reason: smart
            ? `🧠 Smart-money "${smart.label}" is BUYING (${sol.toFixed(2)} SOL).`
            : `🐳 Whale BUY of ${sol.toFixed(2)} SOL.`,
          trader,
          traderLabel: smart?.label,
          solAmount: sol,
          marketCapSol: mcap,
        });
      }
      return;
    }

    // ---- SELL side: exit logic ----
    // Only relevant for tokens we actually entered (i.e. we sent an ENTRY
    // alert). No exit pings for tokens you were never told to buy.
    if (!p.entered) return;
    const isWhaleSell = sol >= config.live.whaleSellSol;

    // 1) smart money selling => terminal EXIT (they're getting out)
    if (smart) {
      return this.exit(p, `🚨 Smart-money "${smart.label}" is SELLING (${sol.toFixed(2)} SOL) — get out now.`, mcap, trader, sol);
    }

    // 2) sudden dump in the window => terminal EXIT
    const windowPeak = Math.max(...p.window.map((w) => w.mcap), mcap);
    const dropFromWindowPeak = windowPeak > 0 ? ((windowPeak - mcap) / windowPeak) * 100 : 0;
    if (dropFromWindowPeak >= config.live.exitDumpPct) {
      return this.exit(p, `🩸 Sudden dump: -${dropFromWindowPeak.toFixed(0)}% in <${DUMP_WINDOW_MS / 1000}s — market-sell.`, mcap);
    }

    // 3) break-even stop: it popped to the first TP then came back => protect
    if (p.breakevenArmed && p.entryMcap && mcap <= p.entryMcap) {
      return this.exit(p, `🟰 Back to break-even after taking first profit — protect capital, exit.`, mcap);
    }

    // 4) trailing stop once in profit => terminal EXIT
    if (p.entered && p.entryMcap && p.peakMcap > p.entryMcap) {
      const dropFromPeak = ((p.peakMcap - mcap) / p.peakMcap) * 100;
      const inProfit = mcap > p.entryMcap;
      if (inProfit && dropFromPeak >= p.trailingStopPct) {
        return this.exit(p, `📉 Trailing stop hit: -${dropFromPeak.toFixed(0)}% from peak — bank the gain.`, mcap);
      }
    }

    // 5) hard stop-loss => terminal EXIT
    if (p.entered && p.entryMcap && mcap <= p.entryMcap * (1 - p.stopLossPct / 100)) {
      const loss = ((p.entryMcap - mcap) / p.entryMcap) * 100;
      return this.exit(p, `🛑 Stop-loss: -${loss.toFixed(0)}% from entry — cut it.`, mcap);
    }

    // 6) a real whale selling => non-terminal WARNING (cooldown)
    if (isWhaleSell && now - p.lastWarnAt > WARN_COOLDOWN_MS) {
      p.lastWarnAt = now;
      this.fire(p, {
        kind: "EXIT_WARNING",
        terminal: false,
        reason: `⚠️ Whale sell of ${sol.toFixed(2)} SOL — watch closely.`,
        trader,
        solAmount: sol,
        marketCapSol: mcap,
      });
    }
  }

  private exit(p: PosState, reason: string, mcap: number, trader?: string, sol?: number) {
    p.exited = true;
    this.fire(p, { kind: "EXIT", terminal: true, reason, trader, solAmount: sol, marketCapSol: mcap });
    this.release(p);
  }

  /** Remove a position: settle its wallet flows (for discovery), then drop it. */
  private release(p: PosState) {
    this.settle(p);
    this.positions.delete(p.mint);
    this.emit("drop", p.mint);
  }

  /** Report round-trip traders on this token so the engine can learn winners. */
  private settle(p: PosState) {
    const roundtrips: { wallet: string; pnlSol: number }[] = [];
    for (const [wallet, f] of p.flows) {
      if (f.buy > 0 && f.sell > 0) roundtrips.push({ wallet, pnlSol: f.sell - f.buy });
    }
    if (roundtrips.length) this.emit("settled", { mint: p.mint, roundtrips });
  }

  private fire(p: PosState, base: Omit<Alert, "mint" | "symbol" | "name" | "at" | "url" | "changeFromEntryPct" | "changeFromPeakPct">) {
    const mcap = base.marketCapSol ?? p.lastMcap;
    const alert: Alert = {
      ...base,
      mint: p.mint,
      symbol: p.symbol,
      name: p.name,
      url: p.url,
      verdict: p.verdict,
      score: p.score,
      at: Date.now(),
      changeFromEntryPct: p.entryMcap ? ((mcap - p.entryMcap) / p.entryMcap) * 100 : null,
      changeFromPeakPct: p.peakMcap ? ((mcap - p.peakMcap) / p.peakMcap) * 100 : 0,
    };
    this.emit("alert", alert);
  }

  positionsDTO(): PositionDTO[] {
    return [...this.positions.values()].map((p) => ({
      mint: p.mint,
      symbol: p.symbol,
      name: p.name,
      openedAt: p.openedAt,
      entered: p.entered,
      exited: p.exited,
      entryMcapSol: p.entryMcap,
      peakMcapSol: p.peakMcap,
      lastMcapSol: p.lastMcap,
      changeFromEntryPct: p.entryMcap ? ((p.lastMcap - p.entryMcap) / p.entryMcap) * 100 : null,
      changeFromPeakPct: p.peakMcap ? ((p.lastMcap - p.peakMcap) / p.peakMcap) * 100 : 0,
      topHolderCount: p.topHolders.size,
    }));
  }

  close(mint: string) {
    const p = this.positions.get(mint);
    if (!p) return false;
    this.release(p);
    return true;
  }

  private evictStale() {
    const ttl = config.live.trackTtlMin * 60_000;
    const now = Date.now();
    for (const p of this.positions.values()) {
      if (now - p.openedAt > ttl) this.release(p);
    }
  }

  private evictOldest() {
    const oldest = [...this.positions.values()].sort((a, b) => a.openedAt - b.openedAt)[0];
    if (oldest) this.release(oldest);
  }
}

export const tracker = new Tracker();
