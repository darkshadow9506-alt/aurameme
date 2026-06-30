// Shared domain types for AuraMeme.

export type TxType = "create" | "buy" | "sell";

/** A raw realtime event coming from the PumpPortal websocket. */
export interface PumpEvent {
  mint: string;
  txType: TxType;
  traderPublicKey?: string;
  solAmount?: number;
  tokenAmount?: number;
  marketCapSol?: number;
  name?: string;
  symbol?: string;
  pool?: string;
  signature?: string;
  /** ms epoch when we received it */
  receivedAt: number;
}

/** On-chain mint authority / freeze authority facts. */
export interface MintFacts {
  mint: string;
  /** true => no one can mint more (good). false => dev can dilute (bad). */
  mintAuthorityRenounced: boolean;
  /** true => no one can freeze your tokens (good). false => dev CAN freeze (critical). */
  freezeAuthorityRenounced: boolean;
  decimals: number;
  supply: number;
}

export interface HolderFacts {
  mint: string;
  topHolders: { owner: string; amount: number; pct: number }[];
  /** % held by the largest single non-pool holder */
  topHolderPct: number;
  /** % held by the top 10 holders combined */
  top10Pct: number;
  holderCount: number | null;
}

export interface MarketFacts {
  mint: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  priceChange: { m5?: number; h1?: number; h6?: number; h24?: number };
  pairCreatedAt: number | null;
  buys24h: number | null;
  sells24h: number | null;
  dexId: string | null;
  url: string | null;
}

/** Insider / sniper bundle analysis from early trades. */
export interface BundleFacts {
  mint: string;
  /** wallets that bought within the first few seconds / creation window */
  earlyBuyerCount: number;
  /** estimated % of supply captured by snipers in the launch window */
  sniperSupplyPct: number;
  /** rough cluster count of wallets funded from the same source */
  clusterCount: number;
}

export interface SmartMoneyHit {
  wallet: string;
  label: string;
  /** historical realized win-rate 0-1 (best effort) */
  winRate: number;
  action: TxType;
  at: number;
}

export type Verdict =
  | "AVOID"
  | "RISKY"
  | "WATCH"
  | "SIGNAL"
  | "STRONG_SIGNAL";

export interface RedFlag {
  code: string;
  severity: "critical" | "high" | "medium" | "low";
  message: string;
}

export interface ExitPlan {
  /** ladder of take-profit targets, expressed as price multiples (x) */
  takeProfits: { multiple: number; sellPct: number }[];
  stopLossPct: number;
  trailingStopPct: number;
  /** human-readable dynamic exit triggers */
  exitTriggers: string[];
}

export interface EntryPlan {
  shouldEnter: boolean;
  reason: string;
  /** suggested max position as % of your *memecoin gambling* budget */
  maxPositionPct: number;
  notes: string[];
}

export interface Analysis {
  mint: string;
  name?: string;
  symbol?: string;
  scoredAt: number;
  score: number; // 0-100
  verdict: Verdict;
  mintFacts?: MintFacts;
  holderFacts?: HolderFacts;
  marketFacts?: MarketFacts;
  bundleFacts?: BundleFacts;
  smartMoney: SmartMoneyHit[];
  redFlags: RedFlag[];
  greenFlags: string[];
  entry: EntryPlan;
  exit: ExitPlan;
}
