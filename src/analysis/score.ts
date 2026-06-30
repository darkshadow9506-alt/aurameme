import type {
  Analysis,
  BundleFacts,
  HolderFacts,
  MarketFacts,
  MintFacts,
  RedFlag,
  SmartMoneyHit,
  Verdict,
} from "../types.js";
import { buildEntryExit } from "../signals/strategy.js";

export interface ScoreInput {
  mint: string;
  name?: string;
  symbol?: string;
  mintFacts?: MintFacts | null;
  holderFacts?: HolderFacts | null;
  marketFacts?: MarketFacts | null;
  bundleFacts?: BundleFacts | null;
  smartMoney?: SmartMoneyHit[];
}

/**
 * Turn raw facts into a 0-100 score + a verdict.
 *
 * Two halves:
 *   SAFETY (can it rug / freeze / be a honeypot?)  — gates everything.
 *   OPPORTUNITY (can it actually pump?)            — only matters once safe.
 *
 * A single CRITICAL safety flag (e.g. freeze authority still live) hard-caps
 * the verdict at AVOID no matter how good the momentum looks. This is the
 * "don't get your money frozen / don't buy a honeypot" guard.
 */
export function scoreToken(input: ScoreInput): Analysis {
  const redFlags: RedFlag[] = [];
  const greenFlags: string[] = [];
  const smartMoney = input.smartMoney ?? [];

  // ---------- SAFETY ----------
  let safety = 100;
  let criticalSafety = false;

  const mf = input.mintFacts;
  if (mf) {
    if (!mf.freezeAuthorityRenounced) {
      redFlags.push({
        code: "FREEZE_AUTHORITY",
        severity: "critical",
        message:
          "Freeze authority is NOT renounced — the dev can freeze your tokens so you can't sell. Top honeypot/scam tell.",
      });
      safety -= 100;
      criticalSafety = true;
    } else {
      greenFlags.push("Freeze authority renounced (your tokens can't be frozen).");
    }

    if (!mf.mintAuthorityRenounced) {
      redFlags.push({
        code: "MINT_AUTHORITY",
        severity: "high",
        message:
          "Mint authority is NOT renounced — the dev can mint more supply and dilute/dump on you.",
      });
      safety -= 35;
    } else {
      greenFlags.push("Mint authority renounced (supply can't be inflated).");
    }
  } else {
    redFlags.push({
      code: "NO_MINT_DATA",
      severity: "medium",
      message: "Could not read on-chain mint data (RPC issue or too new). Treat as unverified.",
    });
    safety -= 15;
  }

  const hf = input.holderFacts;
  if (hf) {
    if (hf.topHolderPct >= 25) {
      redFlags.push({
        code: "WHALE_CONCENTRATION",
        severity: hf.topHolderPct >= 40 ? "critical" : "high",
        message: `Top holder owns ${hf.topHolderPct.toFixed(1)}% — a single dump can nuke the price.`,
      });
      safety -= hf.topHolderPct >= 40 ? 60 : 30;
      if (hf.topHolderPct >= 40) criticalSafety = true;
    }
    if (hf.top10Pct >= 60) {
      redFlags.push({
        code: "TOP10_CONCENTRATION",
        severity: "high",
        message: `Top 10 holders own ${hf.top10Pct.toFixed(1)}% — heavy insider concentration.`,
      });
      safety -= 25;
    } else if (hf.top10Pct > 0 && hf.top10Pct < 35) {
      greenFlags.push(`Holdings fairly spread (top 10 = ${hf.top10Pct.toFixed(1)}%).`);
    }

    // accurate holder count (indexer only)
    if (hf.holderCount != null) {
      if (hf.holderCount < 15) {
        redFlags.push({
          code: "FEW_HOLDERS",
          severity: "medium",
          message: `Only ${hf.holderCount} holders — too few to trust, easy to coordinate a dump.`,
        });
        safety -= 12;
      } else if (hf.holderCount >= 200) {
        greenFlags.push(`Healthy distribution (${hf.holderCount} holders).`);
      }
    }
  }

  const bf = input.bundleFacts;
  if (bf) {
    if (bf.clusterCount >= 5) {
      redFlags.push({
        code: "BUNDLE_LAUNCH",
        severity: bf.clusterCount >= 12 ? "critical" : "high",
        message: `${bf.clusterCount} near-simultaneous launch buys — looks bundled/sniped by insiders.`,
      });
      safety -= bf.clusterCount >= 12 ? 45 : 25;
      if (bf.clusterCount >= 12) criticalSafety = true;
    }
    if (bf.sniperSupplyPct >= 25) {
      redFlags.push({
        code: "SNIPER_SUPPLY",
        severity: "high",
        message: `Snipers grabbed ~${bf.sniperSupplyPct.toFixed(1)}% of supply at launch.`,
      });
      safety -= 20;
    }
    // funder clustering: several early buyers funded by ONE wallet = bundled
    if (bf.funderClusterSize != null && bf.funderClusterSize >= 4) {
      const critical = bf.funderClusterSize >= 8;
      redFlags.push({
        code: "FUNDER_CLUSTER",
        severity: critical ? "critical" : "high",
        message: `${bf.funderClusterSize} early buyers were funded by the SAME wallet — coordinated insider bundle.`,
      });
      safety -= critical ? 45 : 25;
      if (critical) criticalSafety = true;
    }
  }

  safety = clamp(safety, 0, 100);

  // ---------- OPPORTUNITY ----------
  let opp = 0;
  const market = input.marketFacts;
  if (market) {
    const liq = market.liquidityUsd ?? 0;
    if (liq >= 8000) opp += 18;
    else if (liq >= 4000) opp += 10;
    else if (liq > 0) opp += 3;
    if (liq > 0 && liq < 2000)
      redFlags.push({
        code: "THIN_LIQUIDITY",
        severity: "medium",
        message: `Only ${liq.toFixed(0)} USD liquidity — high slippage, easy to manipulate.`,
      });

    // volume / liquidity activity ratio
    const vol = market.volume24hUsd ?? 0;
    const ratio = liq > 0 ? vol / liq : 0;
    if (ratio >= 3) opp += 18;
    else if (ratio >= 1) opp += 10;
    else if (ratio >= 0.3) opp += 4;

    // buy pressure
    const buys = market.buys24h ?? 0;
    const sells = market.sells24h ?? 0;
    if (buys + sells > 30) {
      const buyRatio = buys / (buys + sells);
      if (buyRatio >= 0.6) opp += 12;
      else if (buyRatio >= 0.5) opp += 6;
      else if (buyRatio < 0.4)
        redFlags.push({
          code: "SELL_PRESSURE",
          severity: "medium",
          message: `More sells than buys (${(buyRatio * 100).toFixed(0)}% buys) — momentum fading.`,
        });
    }

    // healthy short-term trend, but not already parabolic
    const h1 = market.priceChange.h1 ?? 0;
    if (h1 > 15 && h1 < 200) opp += 8;
    else if (h1 >= 200)
      redFlags.push({
        code: "PARABOLIC",
        severity: "low",
        message: `Already +${h1.toFixed(0)}% in 1h — chasing here is late/high-risk.`,
      });

    // market-cap sweet spot (early but with proof of life)
    const mc = market.marketCapUsd ?? 0;
    if (mc > 15_000 && mc < 300_000) opp += 8;
  }

  // smart money is the strongest opportunity signal
  const smartBuys = smartMoney.filter((s) => s.action === "buy");
  const smartSells = smartMoney.filter((s) => s.action === "sell");
  if (smartBuys.length) {
    const bonus = Math.min(30, 10 + smartBuys.length * 6);
    opp += bonus;
    greenFlags.push(
      `${smartBuys.length} tracked smart-money wallet(s) are buying.`,
    );
  }
  if (smartSells.length) {
    redFlags.push({
      code: "SMART_MONEY_EXIT",
      severity: "high",
      message: `${smartSells.length} smart-money wallet(s) are SELLING — they may be exiting before a dump.`,
    });
    opp -= 20;
  }

  opp = clamp(opp, 0, 100);

  // ---------- COMBINE ----------
  // Opportunity is weighted by how safe the token is: a risky token's upside is
  // discounted hard. Final = safety acts as a multiplier on opportunity plus a
  // floor from safety itself.
  const safetyFactor = safety / 100;
  let score = Math.round(opp * (0.4 + 0.6 * safetyFactor));
  if (criticalSafety) score = Math.min(score, 15);
  score = clamp(score, 0, 100);

  const verdict = toVerdict(score, criticalSafety);
  const { entry, exit } = buildEntryExit({
    score,
    verdict,
    criticalSafety,
    marketFacts: market ?? undefined,
    smartSelling: smartSells.length > 0,
  });

  return {
    mint: input.mint,
    name: input.name,
    symbol: input.symbol,
    scoredAt: Date.now(),
    score,
    verdict,
    mintFacts: mf ?? undefined,
    holderFacts: hf ?? undefined,
    marketFacts: market ?? undefined,
    bundleFacts: bf ?? undefined,
    smartMoney,
    redFlags: redFlags.sort((a, b) => sev(b.severity) - sev(a.severity)),
    greenFlags,
    entry,
    exit,
  };
}

function toVerdict(score: number, critical: boolean): Verdict {
  if (critical || score < 25) return "AVOID";
  if (score < 45) return "RISKY";
  if (score < 65) return "WATCH";
  if (score < 82) return "SIGNAL";
  return "STRONG_SIGNAL";
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function sev(s: RedFlag["severity"]) {
  return { critical: 4, high: 3, medium: 2, low: 1 }[s];
}
