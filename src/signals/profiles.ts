import { config } from "../config.js";

/**
 * Strategy profiles — the knobs that trade win-rate for upside.
 *
 *   conservative : sell early & often, tight stops  → highest win-rate, small avg
 *   balanced     : de-risk early, let some ride      → solid win-rate, decent avg
 *   aggressive   : small early sells, let runners go  → lower win-rate, bigger avg
 *   moon         : tiny early sells, fat moonbag      → lowest win-rate, fattest tail
 *
 * `npm run sweep` backtests all of them so we can pick the one that maximizes
 * total profit, then it becomes the default below (STRATEGY_PROFILE in .env
 * overrides at runtime).
 */
export interface StrategyProfile {
  name: string;
  /** take-profit ladder; sellPct's may sum to < 100 → the rest is a moonbag */
  takeProfits: { multiple: number; sellPct: number }[];
  /** base stop-loss %, shifted ±5 by verdict strength */
  stopLossBase: number;
  trailingStopPct: number;
  trailingTightPct: number;
  breakevenAfterFirstTp: boolean;
  /** momentum required to confirm an entry (0.08 = +8%) */
  entryConfirmPct: number;
}

export const PROFILES: Record<string, StrategyProfile> = {
  conservative: {
    name: "conservative",
    takeProfits: [
      { multiple: 1.4, sellPct: 30 },
      { multiple: 1.8, sellPct: 25 },
      { multiple: 2.5, sellPct: 25 },
      { multiple: 4, sellPct: 12 },
      { multiple: 8, sellPct: 8 },
    ],
    stopLossBase: 28,
    trailingStopPct: 25,
    trailingTightPct: 18,
    breakevenAfterFirstTp: true,
    entryConfirmPct: 0.1,
  },
  balanced: {
    name: "balanced",
    takeProfits: [
      { multiple: 1.5, sellPct: 20 },
      { multiple: 2, sellPct: 25 },
      { multiple: 3, sellPct: 25 },
      { multiple: 5, sellPct: 20 },
      { multiple: 10, sellPct: 10 },
    ],
    stopLossBase: 35,
    trailingStopPct: 35,
    trailingTightPct: 22,
    breakevenAfterFirstTp: true,
    entryConfirmPct: 0.08,
  },
  aggressive: {
    name: "aggressive",
    takeProfits: [
      { multiple: 2, sellPct: 15 },
      { multiple: 3, sellPct: 20 },
      { multiple: 5, sellPct: 20 },
      { multiple: 10, sellPct: 20 },
      { multiple: 25, sellPct: 15 },
    ],
    stopLossBase: 40,
    trailingStopPct: 45,
    trailingTightPct: 30,
    breakevenAfterFirstTp: true,
    entryConfirmPct: 0.06,
  },
  moon: {
    name: "moon",
    takeProfits: [
      { multiple: 2, sellPct: 10 },
      { multiple: 4, sellPct: 15 },
      { multiple: 8, sellPct: 20 },
      { multiple: 20, sellPct: 20 },
      { multiple: 50, sellPct: 15 },
    ],
    stopLossBase: 45,
    trailingStopPct: 55,
    trailingTightPct: 40,
    breakevenAfterFirstTp: true,
    entryConfirmPct: 0.05,
  },
};

export function activeProfile(): StrategyProfile {
  return PROFILES[config.strategyProfile] ?? PROFILES.balanced;
}
