import "dotenv/config";

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function str(name: string, def = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? def : v;
}

function list(name: string): string[] {
  return str(name)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  telegram: {
    token: str("TELEGRAM_BOT_TOKEN"),
    chatIds: list("TELEGRAM_CHAT_IDS"),
  },
  solanaRpcUrl: str("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"),
  pumpPortalWsUrl: str("PUMPPORTAL_WS_URL", "wss://pumpportal.fun/api/data"),
  dexscreenerBase: str("DEXSCREENER_BASE", "https://api.dexscreener.com"),
  web: {
    port: num("WEB_PORT", 8787),
    host: str("WEB_HOST", "127.0.0.1"),
  },
  engine: {
    signalMinScore: num("SIGNAL_MIN_SCORE", 70),
    minLiquidityUsd: num("MIN_LIQUIDITY_USD", 4000),
    topHoldersCheck: num("TOP_HOLDERS_CHECK", 20),
    smartMoneyWallets: list("SMART_MONEY_WALLETS"),
  },
  dryRun: str("DRY_RUN", "1") !== "0",
} as const;

export type AppConfig = typeof config;
