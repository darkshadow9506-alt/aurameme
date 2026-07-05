import { config } from "../config.js";
import { makeLogger } from "../util/logger.js";
import { limitedFetch } from "../net/limit.js";
import { store } from "../store/store.js";
import type { Analysis } from "../types.js";

const log = makeLogger("survivor");

/**
 * Survivor scanner — the "ANSEM-type" play.
 *
 * Instead of sniping 5-minute-old launches, this hunts tokens that:
 *   - are HOURS-TO-DAYS old and still alive (survived the rug window)
 *   - built real liquidity, volume and a broad holder base
 *   - are verified safe on-chain (authorities renounced, organic spread)
 *   - are STARTING to break out (positive 1h/6h momentum, buy pressure)
 *   - haven't done their main explosion yet (market cap still small)
 *
 * Candidates come from two places each scan:
 *   1. our own graded history (tokens we watched at launch that survived)
 *   2. DexScreener's latest boosted/profiled tokens (things gaining attention)
 *
 * A candidate that passes every check is re-analyzed through the normal
 * pipeline and published as a SURVIVOR signal (Telegram + "I'm in" button).
 */

interface Deps {
  analyze: (mint: string) => Promise<Analysis>;
  publish: (a: Analysis) => void;
}

interface BoostEntry {
  chainId?: string;
  tokenAddress?: string;
}

const RESIGNAL_COOLDOWN_MS = 24 * 3600_000;
/** a candidate that was analyzed and did NOT qualify isn't re-checked for this
 *  long — spreads coverage across the whole history instead of re-burning API
 *  calls on the same 25 dead tokens every scan. */
const RECHECK_COOLDOWN_MS = 90 * 60_000;

export class SurvivorScanner {
  private deps: Deps | null = null;
  private signaled = new Map<string, number>(); // mint -> last signal ts
  private checked = new Map<string, number>(); // mint -> last analyzed ts
  private timer: NodeJS.Timeout | null = null;

  start(deps: Deps) {
    if (!config.survivor.enabled) {
      log.info("survivor scanner disabled (SURVIVOR_ENABLED=0)");
      return;
    }
    this.deps = deps;
    const every = Math.max(2, config.survivor.scanEveryMin) * 60_000;
    this.timer = setInterval(() => void this.scan(), every);
    this.timer.unref();
    // first scan shortly after boot (give the feed a moment to settle)
    setTimeout(() => void this.scan(), 30_000).unref();
    log.ok(`survivor scanner on — every ${config.survivor.scanEveryMin}min`);
  }

  /** One scan pass: gather candidates, re-analyze, publish the survivors. */
  async scan(): Promise<number> {
    if (!this.deps) return 0;
    const candidates = await this.gatherCandidates();
    let hits = 0;
    for (const mint of candidates) {
      try {
        this.checked.set(mint, Date.now());
        const a = await this.deps.analyze(mint);
        if (this.qualifies(a)) {
          this.signaled.set(mint, Date.now());
          a.signalKind = "SURVIVOR";
          a.conviction = true; // rides the same "quality signal" rail
          a.convictionReasons = this.reasons(a);
          this.deps.publish(a);
          hits++;
        }
      } catch (e) {
        log.debug(`survivor analyze ${mint.slice(0, 8)} failed:`, (e as Error).message);
      }
    }
    if (hits) log.ok(`scan done — ${hits} survivor signal(s)`);
    return hits;
  }

  /** All hard criteria — every one must hold. Exported for tests via check(). */
  qualifies(a: Analysis): boolean {
    const s = config.survivor;
    const m = a.marketFacts;
    if (!m) return false;

    // recently signaled → don't repeat
    const last = this.signaled.get(a.mint) ?? 0;
    if (Date.now() - last < RESIGNAL_COOLDOWN_MS) return false;

    // proven age: survived well past the rug window
    const age = m.pairCreatedAt ? Date.now() - m.pairCreatedAt : 0;
    if (age < s.minAgeHours * 3600_000) return false;

    // alive & liquid
    if ((m.liquidityUsd ?? 0) < s.minLiquidityUsd) return false;
    if ((m.volume24hUsd ?? 0) < s.minVolume24hUsd) return false;

    // pre-explosion: cap still has room
    const mcap = m.marketCapUsd ?? 0;
    if (mcap <= 0 || mcap > s.maxMarketCapUsd) return false;

    // verified safe on-chain
    if (!a.mintFacts?.freezeAuthorityRenounced || !a.mintFacts?.mintAuthorityRenounced)
      return false;

    // organic, broad holder base — REQUIRED. A survivor signal claims verified
    // safety, so "couldn't read holder data" is a rejection, not a pass.
    const hf = a.holderFacts;
    if (!hf) return false;
    if (hf.topHolderPct > 25 || hf.top10Pct > 55) return false;
    if (hf.holderCount != null && hf.holderCount < s.minHolders) return false;

    // breaking out NOW, with real buy pressure — but not already parabolic
    const h1 = m.priceChange.h1 ?? 0;
    const h6 = m.priceChange.h6 ?? 0;
    if (h1 < s.minH1Pct || h6 <= 0) return false;
    if (h1 > 300) return false; // main explosion already happened — too late
    const buys = m.buys24h ?? 0;
    const sells = m.sells24h ?? 0;
    if (buys + sells < 100 || buys <= sells) return false;

    // real trading intensity relative to depth
    const ratio = (m.volume24hUsd ?? 0) / Math.max(1, m.liquidityUsd ?? 0);
    if (ratio < 1.5) return false;

    return true;
  }

  private reasons(a: Analysis): string[] {
    const m = a.marketFacts!;
    const ageH = m.pairCreatedAt ? Math.round((Date.now() - m.pairCreatedAt) / 3600_000) : 0;
    const out = [
      `🦅 survivor: ${ageH >= 48 ? `${Math.round(ageH / 24)} days` : `${ageH}h`} old and still growing (not a 5-min rug)`,
      `✅ safety verified: authorities renounced, organic holder spread`,
      `💧 real depth: $${Math.round((m.liquidityUsd ?? 0) / 1000)}K liquidity, $${Math.round((m.volume24hUsd ?? 0) / 1000)}K volume/24h`,
      `📈 breaking out: +${(m.priceChange.h1 ?? 0).toFixed(0)}% (1h), buys>sells — before the main run`,
    ];
    if (a.holderFacts?.holderCount) out.splice(2, 0, `👥 ${a.holderFacts.holderCount} holders`);
    return out;
  }

  /** eligible = not signaled in 24h AND not already checked in the last 90min */
  private eligible(mint: string): boolean {
    const now = Date.now();
    if (now - (this.signaled.get(mint) ?? 0) < RESIGNAL_COOLDOWN_MS) return false;
    if (now - (this.checked.get(mint) ?? 0) < RECHECK_COOLDOWN_MS) return false;
    return true;
  }

  private async gatherCandidates(): Promise<string[]> {
    const out = new Set<string>();
    const cap = config.survivor.candidatesPerScan;

    // 1) DexScreener attention feeds FIRST (boosted/profiled Solana tokens) —
    //    these are alive and gaining attention right now, the best candidates.
    for (const path of ["/token-boosts/latest/v1", "/token-profiles/latest/v1"]) {
      if (out.size >= cap) break;
      try {
        const res = await limitedFetch(`${config.dexscreenerBase}${path}`);
        if (!res.ok) continue;
        const list = (await res.json()) as BoostEntry[];
        for (const e of Array.isArray(list) ? list : []) {
          if (out.size >= cap) break;
          if (e.chainId === "solana" && e.tokenAddress && this.eligible(e.tokenAddress))
            out.add(e.tokenAddress);
        }
      } catch (e) {
        log.debug(`candidates ${path} failed:`, (e as Error).message);
      }
    }

    // 2) our own graded history: launches old enough to have proven themselves.
    //    The recheck cooldown rotates coverage through the whole history
    //    instead of re-analyzing the same first slice every scan.
    const minAgeMs = config.survivor.minAgeHours * 3600_000;
    for (const a of store.recentAnalyses(1500)) {
      if (out.size >= cap) break;
      if (Date.now() - a.scoredAt < minAgeMs) continue;
      if (a.verdict === "AVOID") continue; // known-bad at launch stays out
      if (this.eligible(a.mint)) out.add(a.mint);
    }

    // bound the cooldown maps (they only ever grow otherwise)
    if (this.checked.size > 20_000) {
      const cutoff = Date.now() - RECHECK_COOLDOWN_MS;
      for (const [m, t] of this.checked) if (t < cutoff) this.checked.delete(m);
    }

    return [...out].slice(0, cap);
  }
}

export const survivorScanner = new SurvivorScanner();
