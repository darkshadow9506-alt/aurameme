import { EventEmitter } from "node:events";
import { config } from "./config.js";
import { makeLogger } from "./util/logger.js";
import { PumpPortal } from "./sources/pumpportal.js";
import { getMintFacts, getHolderFacts } from "./sources/solanaRpc.js";
import { getMarketFacts } from "./sources/dexscreener.js";
import { getHolderStats, clusterEarlyBuyers } from "./sources/indexer.js";
import { EarlyTradeCollector } from "./analysis/bundle.js";
import { scoreToken } from "./analysis/score.js";
import {
  classifyWalletTrade,
  noteCreator,
} from "./analysis/smartMoney.js";
import { store } from "./store/store.js";
import { tracker } from "./live/tracker.js";
import type { Analysis, PumpEvent, SmartMoneyHit } from "./types.js";

const log = makeLogger("engine");

/** Time after creation that we observe the launch before grading it. */
const LAUNCH_OBSERVE_MS = 30_000;

/**
 * The orchestrator. Wires the realtime feed to the analysis pipeline and emits
 * graded "signal" events that the Telegram bot / web dashboard consume.
 *
 * Emits:
 *   "analysis" (Analysis)  — every graded token (any verdict)
 *   "signal"   (Analysis)  — only tokens that clear SIGNAL_MIN_SCORE
 *   "smartHit" ({hit, mint}) — a tracked wallet traded
 */
export class Engine extends EventEmitter {
  readonly feed = new PumpPortal();
  private collector = new EarlyTradeCollector();
  private pending = new Set<string>();

  start() {
    // seed smart-money watch list
    for (const w of config.engine.smartMoneyWallets) {
      store.addSmart(w, "seed");
      this.feed.watchWallet(w);
    }

    this.feed.on("newToken", (ev: PumpEvent) => this.onNewToken(ev));
    this.feed.on("trade", (ev: PumpEvent) => {
      this.collector.push(ev);
      tracker.onTrade(ev);
    });
    this.feed.on("walletTrade", (ev: PumpEvent) => this.onWalletTrade(ev));

    // tracker tells us when to release a token; its alerts are re-emitted.
    tracker.on("drop", (mint: string) => this.feed.unwatchToken(mint));
    tracker.on("alert", (alert) => this.emit("alert", alert));
    tracker.start();

    this.feed.start();
    log.ok("engine started — listening for new pump.fun tokens");
  }

  private onNewToken(ev: PumpEvent) {
    if (this.pending.has(ev.mint)) return;
    this.pending.add(ev.mint);
    noteCreator(ev.mint, ev.traderPublicKey);
    this.collector.open(ev.mint, ev.receivedAt);
    this.feed.watchToken(ev.mint);
    log.info(`new token ${ev.symbol ?? ""} ${ev.mint.slice(0, 8)}… — observing ${LAUNCH_OBSERVE_MS / 1000}s`);

    setTimeout(() => void this.gradeLaunch(ev), LAUNCH_OBSERVE_MS);
  }

  private async gradeLaunch(ev: PumpEvent) {
    this.pending.delete(ev.mint);
    const { facts: bundleFacts, buyers } = this.collector.finalize(ev.mint);
    this.feed.unwatchToken(ev.mint);
    try {
      // deep bundle detection: do many early buyers share one SOL funder?
      const cluster = await clusterEarlyBuyers(buyers);
      if (cluster) {
        bundleFacts.funderClusterSize = cluster.largestCluster;
        bundleFacts.funderGroups = cluster.funderGroups;
      }
      const analysis = await this.analyzeMint(ev.mint, {
        name: ev.name,
        symbol: ev.symbol,
        bundleFacts,
      });
      this.publish(analysis);

      // Keep watching promising tokens live so we can catch whale entries and
      // dump exits; drop the rest to save the websocket budget.
      if (isTrackable(analysis)) {
        tracker.open(analysis);
      } else {
        this.feed.unwatchToken(ev.mint);
      }
    } catch (e) {
      log.warn(`grade failed ${ev.mint.slice(0, 8)}:`, (e as Error).message);
      this.feed.unwatchToken(ev.mint);
    }
  }

  /** Full fact-gather + score for a single mint. Reusable by /check and scan. */
  async analyzeMint(
    mint: string,
    extra: {
      name?: string;
      symbol?: string;
      bundleFacts?: Analysis["bundleFacts"];
      smartMoney?: SmartMoneyHit[];
    } = {},
  ): Promise<Analysis> {
    const [mintFacts, indexerHolders, marketFacts] = await Promise.all([
      getMintFacts(mint),
      getHolderStats(mint),
      getMarketFacts(mint),
    ]);
    // Prefer accurate indexer holder data; fall back to the RPC top-20 read.
    const holderFacts =
      indexerHolders ??
      (await getHolderFacts(mint, config.engine.topHoldersCheck));

    const analysis = scoreToken({
      mint,
      name: extra.name,
      symbol: extra.symbol,
      mintFacts,
      holderFacts,
      marketFacts,
      bundleFacts: extra.bundleFacts ?? null,
      smartMoney: extra.smartMoney ?? [],
    });
    return analysis;
  }

  private publish(a: Analysis) {
    store.upsertAnalysis(a);
    this.emit("analysis", a);

    const passesLiquidity =
      (a.marketFacts?.liquidityUsd ?? 0) >= config.engine.minLiquidityUsd ||
      a.smartMoney.some((s) => s.action === "buy");

    if (a.score >= config.engine.signalMinScore && passesLiquidity) {
      log.ok(`SIGNAL ${a.verdict} ${a.score} — ${a.symbol ?? a.mint.slice(0, 8)}`);
      this.emit("signal", a);
    } else {
      log.debug(`graded ${a.verdict} ${a.score} — ${a.mint.slice(0, 8)}`);
    }
  }

  private async onWalletTrade(ev: PumpEvent) {
    const hit = classifyWalletTrade(ev);
    if (!hit) return;
    log.info(`smart-money ${hit.action.toUpperCase()} by ${hit.label} on ${ev.mint.slice(0, 8)}`);
    this.emit("smartHit", { hit, mint: ev.mint, event: ev });

    // Make sure we're following this token's stream so entry/exit fire live,
    // then let the tracker turn the smart-money trade into an alert.
    if (!tracker.isTracking(ev.mint)) this.feed.watchToken(ev.mint);

    // Re-grade the token now that smart money touched it, so the signal carries
    // the smart-money context.
    try {
      const a = await this.analyzeMint(ev.mint, {
        name: ev.name,
        symbol: ev.symbol,
        smartMoney: [hit],
      });
      this.publish(a);
      if (isTrackable(a)) tracker.open(a);
    } catch {
      /* ignore re-grade errors */
    }
    // feed the trade to the tracker so a smart buy/sell becomes an entry/exit
    tracker.onTrade(ev);
  }

  // ---- watchlist management used by Telegram commands ----
  addSmartWallet(wallet: string, label = "manual") {
    store.addSmart(wallet, label);
    this.feed.watchWallet(wallet);
  }
  removeSmartWallet(wallet: string) {
    this.feed.unwatchWallet(wallet);
    return store.removeSmart(wallet);
  }
}

/** Worth following live? Track WATCH+ tokens (or anything smart money touched). */
function isTrackable(a: Analysis): boolean {
  if (a.verdict === "AVOID" || a.verdict === "RISKY") {
    return a.smartMoney.length > 0; // still follow if smart money is involved
  }
  return true;
}

export const engine = new Engine();
