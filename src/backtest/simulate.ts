import { buildEntryExit } from "../signals/strategy.js";
import { activeProfile, type StrategyProfile } from "../signals/profiles.js";
import type { Verdict } from "../types.js";

/**
 * Backtester core.
 *
 * Replays a token's market-cap (price proxy) series through the SAME entry/exit
 * plan the live bot uses (`buildEntryExit`), so the numbers reflect the real
 * strategy — tiered take-profits, trailing stop, hard stop, and the dynamic
 * dump-protection exits (smart-money sell / rug) — and compares them against a
 * naive buy-and-hold.
 */

export interface BtEvent {
  /** index into `series` where the event lands */
  at: number;
  type: "smartSell" | "rug" | "smartBuy";
}

export interface BtPoint {
  mcap: number;
  liq?: number;
}

export interface BtToken {
  mint: string;
  name?: string;
  verdict?: Verdict;
  /** chronological market-cap points (price proxy) */
  series: BtPoint[];
  events?: BtEvent[];
  /** index where we enter (whale/smart buy). default 0 */
  entryIndex?: number;
}

export interface TradeResult {
  mint: string;
  name?: string;
  traded: boolean;
  /** realized return as a multiple of cost (1 = break-even, 2 = doubled) */
  strategy: number;
  /** naive buy-and-hold over the same window (rug => ~0) */
  buyHold: number;
  peakMultiple: number;
  exitReason: string;
}

/** Fraction of value you actually salvage when a rug/LP-pull fires mid-exit. */
const RUG_FILL = 0.3;

export function simulatePosition(token: BtToken, profile: StrategyProfile = activeProfile()): TradeResult {
  const series = token.series;
  const verdict: Verdict = token.verdict ?? "SIGNAL";
  let entryIdx = token.entryIndex ?? 0;

  const { entry, exit } = buildEntryExit({
    score: verdict === "STRONG_SIGNAL" ? 85 : verdict === "SIGNAL" ? 72 : 55,
    verdict,
    criticalSafety: verdict === "AVOID",
    smartSelling: false,
    profile,
  });

  // Confirmation entry — mirrors the live rule "get in when whales/smart money
  // buy". We enter on the smart-buy event, or on the first sign of upward
  // momentum (+8% within the opening window). Tokens that only bleed from the
  // start are never entered, which is the cleanest win-rate lever.
  const events = token.events ?? [];
  const smartBuyIdx = events.find((e) => e.type === "smartBuy" && e.at >= entryIdx)?.at;
  let enterAt = -1;
  if (smartBuyIdx != null && verdict !== "AVOID") {
    enterAt = smartBuyIdx;
  } else if (verdict !== "AVOID" && entry.shouldEnter) {
    const base = series[entryIdx].mcap;
    const window = Math.min(series.length - 1, entryIdx + 12);
    for (let i = entryIdx + 1; i <= window; i++) {
      if (series[i].mcap >= base * (1 + profile.entryConfirmPct)) {
        enterAt = i;
        break;
      }
    }
  }
  if (enterAt < 0 || series.length <= enterAt + 1) {
    return {
      mint: token.mint,
      name: token.name,
      traded: false,
      strategy: 1,
      buyHold: 1,
      peakMultiple: 1,
      exitReason: "no entry (no momentum confirmation)",
    };
  }
  entryIdx = enterAt;

  const entryPrice = series[entryIdx].mcap;
  const eventAt = new Map<number, BtEvent["type"]>();
  for (const e of token.events ?? []) if (e.at > entryIdx) eventAt.set(e.at, e.type);

  // tier sold flags
  const tiers = exit.takeProfits.map((t) => ({ ...t, done: false }));
  let remaining = 1; // fraction of position still held
  let realized = 0; // accumulated proceeds in cost-multiples
  let peakMultiple = 1;
  let tpHits = 0; // how many take-profit tiers have filled
  let exitReason = "rode to end of window";

  const sellAll = (priceMult: number, reason: string) => {
    realized += remaining * priceMult;
    remaining = 0;
    exitReason = reason;
  };

  for (let i = entryIdx + 1; i < series.length && remaining > 0; i++) {
    const mult = series[i].mcap / entryPrice;
    if (mult > peakMultiple) peakMultiple = mult;

    // dynamic dump-protection exits first (they model the live triggers)
    const ev = eventAt.get(i);
    if (ev === "rug") {
      sellAll(mult * RUG_FILL, "rug/LP-pull exit (heavy slippage)");
      break;
    }
    if (ev === "smartSell") {
      sellAll(mult, "smart-money sell trigger");
      break;
    }

    // take-profit ladder (limit fills at the target multiple)
    for (const t of tiers) {
      if (!t.done && mult >= t.multiple) {
        realized += (t.sellPct / 100) * t.multiple;
        remaining -= t.sellPct / 100;
        t.done = true;
        tpHits++;
      }
    }
    if (remaining <= 0.0001) {
      remaining = 0;
      exitReason = "full take-profit ladder";
      break;
    }

    // trailing stop once in profit (tightens after the 2nd take-profit)
    const trail = tpHits >= 2 ? exit.trailingTightPct : exit.trailingStopPct;
    if (mult > 1 && mult <= peakMultiple * (1 - trail / 100)) {
      sellAll(mult, "trailing stop");
      break;
    }

    // stop-loss: break-even once the first TP is banked, else the hard stop.
    // This is the win-rate lever: a trade that popped to 1.5x can't go red.
    const stopFloor = exit.breakevenAfterFirstTp && tpHits >= 1 ? 1 : 1 - exit.stopLossPct / 100;
    if (mult <= stopFloor) {
      sellAll(mult, tpHits >= 1 ? "break-even stop (profit protected)" : "stop-loss");
      break;
    }
  }

  if (remaining > 0) {
    const lastMult = series[series.length - 1].mcap / entryPrice;
    realized += remaining * lastMult;
  }

  // buy & hold baseline
  const rugged = (token.events ?? []).some((e) => e.type === "rug");
  const buyHold = rugged ? 0 : series[series.length - 1].mcap / entryPrice;

  return {
    mint: token.mint,
    name: token.name,
    traded: true,
    strategy: round(realized),
    buyHold: round(buyHold),
    peakMultiple: round(peakMultiple),
    exitReason,
  };
}

export interface BtSummary {
  tokens: number;
  traded: number;
  wins: number;
  losses: number;
  winRate: number;
  avgStrategy: number;
  medianStrategy: number;
  avgBuyHold: number;
  totalStrategyPnL: number; // sum(result-1) over traded, in units of risked size
  totalBuyHoldPnL: number;
  best: TradeResult | null;
  worst: TradeResult | null;
  results: TradeResult[];
}

export function runBacktest(tokens: BtToken[], profile: StrategyProfile = activeProfile()): BtSummary {
  const results = tokens.map((t) => simulatePosition(t, profile));
  const traded = results.filter((r) => r.traded);
  const wins = traded.filter((r) => r.strategy > 1);
  const sStrat = traded.map((r) => r.strategy).sort((a, b) => a - b);
  const median = sStrat.length ? sStrat[Math.floor(sStrat.length / 2)] : 1;

  const sum = (arr: number[]) => arr.reduce((s, x) => s + x, 0);
  return {
    tokens: tokens.length,
    traded: traded.length,
    wins: wins.length,
    losses: traded.length - wins.length,
    winRate: traded.length ? wins.length / traded.length : 0,
    avgStrategy: traded.length ? round(sum(traded.map((r) => r.strategy)) / traded.length) : 0,
    medianStrategy: round(median),
    avgBuyHold: traded.length ? round(sum(traded.map((r) => r.buyHold)) / traded.length) : 0,
    totalStrategyPnL: round(sum(traded.map((r) => r.strategy - 1))),
    totalBuyHoldPnL: round(sum(traded.map((r) => r.buyHold - 1))),
    best: traded.slice().sort((a, b) => b.strategy - a.strategy)[0] ?? null,
    worst: traded.slice().sort((a, b) => a.strategy - b.strategy)[0] ?? null,
    results,
  };
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}
