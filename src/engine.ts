import { EventEmitter } from "node:events";
import { config } from "./config.js";
import { makeLogger } from "./util/logger.js";
import { createFeed, type TokenFeed } from "./sources/feed.js";
import { getMintFacts, getHolderFacts } from "./sources/solanaRpc.js";
import { getMarketFacts } from "./sources/dexscreener.js";
import { getHolderStats, clusterEarlyBuyers } from "./sources/indexer.js";
import { EarlyTradeCollector } from "./analysis/bundle.js";
import { scoreToken } from "./analysis/score.js";
import {
  classifyWalletTrade,
  noteCreator,
  recordRoundTrip,
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
  readonly feed: TokenFeed = createFeed();
  private collector = new EarlyTradeCollector();
  private pending = new Set<string>();
  /** how many tokens are mid-analysis right now (back-pressure for the firehose) */
  private grading = 0;
  private stats = { graded: 0, signals: 0, alerts: 0 };

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
    tracker.on("alert", () => this.stats.alerts++);
    // tracker reports round-trip traders on closed tokens → learn the winners
    tracker.on("settled", (s: { mint: string; roundtrips: { wallet: string; pnlSol: number }[] }) =>
      this.onSettled(s),
    );
    tracker.start();

    // periodic health heartbeat so you can see at a glance it's alive & working
    setInterval(() => {
      log.info(
        `stats: graded=${this.stats.graded} signals=${this.stats.signals} alerts=${this.stats.alerts} ` +
          `tracking=${tracker.positionsDTO().length} smartWallets=${store.smartCount()}`,
      );
    }, 60_000).unref();

    this.feed.start();

    // Restore exit protection for positions users opened before a restart: the
    // tracker is empty on boot, so re-watch and re-arm every open user position.
    for (const mint of new Set(store.allUserPositions().map((p) => p.mint))) {
      void this.ensureTracked(mint);
    }

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

    // Firehose control: a token that attracted ZERO buys in the observation
    // window is dead on arrival — skip it so we don't waste rate-limited API
    // calls (and risk a free RPC tier) on launches nobody touched.
    if (bundleFacts.earlyBuyerCount === 0) {
      this.feed.unwatchToken(ev.mint);
      return;
    }

    // Back-pressure: if we're already saturated with in-flight analyses, drop
    // this one rather than letting the request queue grow without bound. Most
    // launches are junk, so shedding load under a burst is the right call.
    if (this.grading >= config.engine.maxGradingInflight) {
      this.feed.unwatchToken(ev.mint);
      return;
    }
    this.grading++;

    // NOTE: the token stays subscribed here. If it's trackable we hand it to the
    // tracker (which needs the live trade stream); only non-trackable tokens are
    // unwatched below, so we don't kill the entry/exit feed.
    try {
      // deep bundle detection: do many early buyers share one SOL funder?
      // Heavy (many RPC calls per token) — opt-in via ENABLE_FUNDER_CLUSTER.
      if (config.engine.enableFunderCluster) {
        const cluster = await clusterEarlyBuyers(buyers);
        if (cluster) {
          bundleFacts.funderClusterSize = cluster.largestCluster;
          bundleFacts.funderGroups = cluster.funderGroups;
        }
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
    } finally {
      this.grading--;
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
    this.stats.graded++;
    this.emit("analysis", a);

    // Only the strict, high-conviction picks become signals (a few a day) —
    // safe + organic demand + whale/smart money + pumping. Quality over quantity.
    if (a.conviction) {
      this.stats.signals++;
      log.ok(`🔥 CONVICTION SIGNAL ${a.score} — ${a.symbol ?? a.mint.slice(0, 8)}`);
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

    // Make sure we're following this token's stream so entry/exit fire live.
    const wasTracking = tracker.isTracking(ev.mint);
    if (!wasTracking) this.feed.watchToken(ev.mint);

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
    // Deliver THIS trade to the tracker only on first touch. Once the token is
    // tracked it's also subscribed, so the "trade" stream delivers every
    // subsequent trade — avoid double-processing the same event.
    if (!wasTracking) tracker.onTrade(ev);
  }

  /**
   * Learn smart-money wallets automatically: a wallet that round-tripped a
   * tracked token (bought AND sold) for a real profit gets promoted into the
   * watch table and subscribed, so its FUTURE buys become entry signals. The
   * token's creator is never promoted (handled inside recordRoundTrip).
   */
  private onSettled(s: { mint: string; roundtrips: { wallet: string; pnlSol: number }[] }) {
    for (const r of s.roundtrips) {
      const already = store.isSmart(r.wallet);
      if (already) {
        recordRoundTrip(r.wallet, s.mint, r.pnlSol); // keep its W/L record current
      } else if (r.pnlSol >= config.engine.discoveryMinProfitSol) {
        recordRoundTrip(r.wallet, s.mint, r.pnlSol); // promote a real winner
        if (store.isSmart(r.wallet) && store.smartCount() <= config.engine.maxWatchedWallets) {
          this.feed.watchWallet(r.wallet);
          log.ok(`discovered smart wallet ${r.wallet.slice(0, 6)}… (+${r.pnlSol.toFixed(2)} SOL)`);
        }
      }
    }
  }

  /**
   * Make sure a token is live-tracked with its exit triggers ARMED — used when
   * a user taps "I'm in" and on startup to restore persisted positions. If the
   * tracker doesn't know the token (evicted / restart), re-analyze and re-open.
   */
  async ensureTracked(mint: string): Promise<void> {
    if (!tracker.isTracking(mint)) {
      this.feed.watchToken(mint);
      try {
        const a = await this.analyzeMint(mint);
        store.upsertAnalysis(a);
        tracker.open(a);
      } catch (e) {
        log.warn(`ensureTracked(${mint.slice(0, 8)}) analyze failed:`, (e as Error).message);
      }
    }
    tracker.markEntered(mint);
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

/**
 * Worth following live? We track on real early *traction*, not just the static
 * grade — the whole point is to be watching when a whale buys. A fresh token is
 * naturally concentrated (few holders yet), which tanks its grade, but that's
 * exactly the kind of token we want to watch for a whale entry. The one thing
 * we refuse to follow is a honeypot (freeze authority live = you can't sell).
 */
function isTrackable(a: Analysis): boolean {
  // never follow a token you might not be able to sell
  if (a.mintFacts && !a.mintFacts.freezeAuthorityRenounced) return false;
  // smart money already in, or a genuinely good grade → follow
  if (a.smartMoney.length > 0) return true;
  if (a.verdict !== "AVOID" && a.verdict !== "RISKY") return true;
  // otherwise follow anything with real early traction (catch the whale entry)
  const bf = a.bundleFacts;
  return Boolean(bf && (bf.earlyBuyerCount ?? 0) >= 4 && (bf.earlySolVolume ?? 0) >= 2);
}

export const engine = new Engine();
