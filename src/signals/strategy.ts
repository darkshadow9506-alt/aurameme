import type { EntryPlan, ExitPlan, MarketFacts, Verdict } from "../types.js";

export interface StrategyInput {
  score: number;
  verdict: Verdict;
  criticalSafety: boolean;
  marketFacts?: MarketFacts;
  smartSelling: boolean;
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
  // Tiered take-profit ladder: bank cost basis early, ride the rest.
  const takeProfits = [
    { multiple: 2, sellPct: 35 }, // at 2x sell 35% -> de-risk most of cost
    { multiple: 3, sellPct: 25 },
    { multiple: 5, sellPct: 20 },
    { multiple: 10, sellPct: 10 }, // moonbag
    // remaining ~10% rides on the trailing stop only
  ];

  // tighter stops for riskier setups
  const stopLossPct = verdict === "STRONG_SIGNAL" ? 40 : verdict === "SIGNAL" ? 35 : 30;
  const trailingStopPct = 35;

  const exitTriggers = [
    "Smart-money wallets start SELLING → exit immediately, don't wait for the chart.",
    `Liquidity drops > 30% suddenly → likely LP pull / rug → market-sell now.`,
    "Top holder / dev wallet sends a large transfer or sell → exit.",
    "Buy/sell ratio flips and volume dries up after a spike → take profit, momentum gone.",
    `Trailing stop: once in profit, exit if price falls ${trailingStopPct}% from its peak.`,
    "Freeze authority appears / mint authority used → exit instantly (sell-while-you-can).",
  ];
  if (smartSelling)
    exitTriggers.unshift("⚠️ Smart money is ALREADY selling on this token right now.");

  const exit: ExitPlan = { takeProfits, stopLossPct, trailingStopPct, exitTriggers };

  return { entry, exit };
}
