import type { EntryPlan, ExitPlan, MarketFacts, Verdict } from "../types.js";
import { activeProfile, type StrategyProfile } from "./profiles.js";

export interface StrategyInput {
  score: number;
  verdict: Verdict;
  criticalSafety: boolean;
  marketFacts?: MarketFacts;
  smartSelling: boolean;
  /** override the active profile (used by the backtest sweep) */
  profile?: StrategyProfile;
}

/**
 * Build a concrete, risk-managed entry & exit plan.
 *
 * HONEST DISCLAIMER (also shown to the user): no plan can guarantee you exit
 * before a dump or that you keep all your profit. Memecoins can go -90% in one
 * candle and liquidity can be pulled instantly. These are *risk-management
 * rules* that tilt the odds, size positions sanely, and define mechanical exits
 * so you don't freeze when it moves. Always use money you can afford to lose.
 */
export function buildEntryExit(input: StrategyInput): {
  entry: EntryPlan;
  exit: ExitPlan;
} {
  const { score, verdict, criticalSafety, marketFacts, smartSelling } = input;
  const profile = input.profile ?? activeProfile();

  // ----- ENTRY -----
  const notes: string[] = [];
  let shouldEnter = false;
  let maxPositionPct = 0;
  let reason: string;

  if (criticalSafety) {
    reason = "Critical safety flag — do NOT enter (rug/freeze/honeypot risk).";
  } else if (verdict === "AVOID" || verdict === "RISKY") {
    reason = "Score too low / risk too high to justify an entry.";
  } else {
    shouldEnter = true;
    if (verdict === "STRONG_SIGNAL") {
      maxPositionPct = 8;
      reason = "Strong setup: safety checks passed and momentum + smart-money align.";
    } else if (verdict === "SIGNAL") {
      maxPositionPct = 5;
      reason = "Valid setup: safety acceptable and momentum building.";
    } else {
      // WATCH
      maxPositionPct = 2;
      shouldEnter = false;
      reason = "On watch — wait for confirmation (smart-money buy, volume, or a clean retest) before entering.";
    }
    notes.push(
      "Enter in 2 parts: half now, half on a higher-low retest — don't market-buy the full size into a green candle.",
    );
    const liq = marketFacts?.liquidityUsd ?? 0;
    if (liq < 10_000)
      notes.push(
        `Liquidity is ~$${liq.toFixed(0)}: keep size small, expect heavy slippage, set slippage 8-15%.`,
      );
  }
  notes.push(
    "Position % is of your MEMECOIN gambling budget only — that budget should be money you can lose 100% of.",
  );

  const entry: EntryPlan = { shouldEnter, reason, maxPositionPct, notes };

  // ----- EXIT -----
  // The take-profit ladder comes from the active profile. The FIRST tier
  // de-risks early so that, combined with moving the stop to break-even
  // afterwards, most pumps that fade still close green — the main win-rate
  // lever. Aggressive/moon profiles sell less early and let runners go.
  const takeProfits = profile.takeProfits;
  const firstTp = takeProfits[0]?.multiple ?? 1.5;

  // tighter stops for riskier setups, biased around the profile base
  const stopLossPct =
    profile.stopLossBase + (verdict === "STRONG_SIGNAL" ? 5 : verdict === "SIGNAL" ? 0 : -5);
  const trailingStopPct = profile.trailingStopPct;
  const trailingTightPct = profile.trailingTightPct; // after the 2nd TP, lock gains harder

  const exitTriggers = [
    `✅ After the FIRST take-profit (${firstTp}x), move your stop to BREAK-EVEN — now the trade can't become a loss.`,
    "Smart-money wallets start SELLING → exit immediately, don't wait for the chart.",
    `Liquidity drops > 30% suddenly → likely LP pull / rug → market-sell now.`,
    "Top holder / dev wallet sends a large transfer or sell → exit.",
    "Buy/sell ratio flips and volume dries up after a spike → take profit, momentum gone.",
    `Trailing stop: ${trailingStopPct}% from peak (tightens to ${trailingTightPct}% after the 2nd take-profit).`,
    "Freeze authority appears / mint authority used → exit instantly (sell-while-you-can).",
  ];
  if (smartSelling)
    exitTriggers.unshift("⚠️ Smart money is ALREADY selling on this token right now.");

  const exit: ExitPlan = {
    takeProfits,
    stopLossPct,
    trailingStopPct,
    breakevenAfterFirstTp: profile.breakevenAfterFirstTp,
    trailingTightPct,
    exitTriggers,
  };

  return { entry, exit };
}
