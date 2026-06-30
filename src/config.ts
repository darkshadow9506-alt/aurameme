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
  // Route all outbound traffic through a proxy (for running inside Iran on your
  // own machine). Supports http://, https://, socks5://, socks4:// URLs.
  proxyUrl: str("PROXY_URL") || str("HTTPS_PROXY") || str("ALL_PROXY"),
  solanaRpcUrl: str("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"),
  pumpPortalWsUrl: str("PUMPPORTAL_WS_URL", "wss://pumpportal.fun/api/data"),
  dexscreenerBase: str("DEXSCREENER_BASE", "https://api.dexscreener.com"),
  // Realtime feed: "pumpportal" (default) or "solana" (direct RPC program logs,
  // for when pumpportal.fun is blocked from your VPN exit).
  feedSource: str("FEED_SOURCE", "pumpportal"),
  // Optional indexers — unlock accurate holder counts & funder clustering.
  heliusApiKey: str("HELIUS_API_KEY"),
  birdeyeApiKey: str("BIRDEYE_API_KEY"),
  web: {
    port: num("WEB_PORT", 8787),
    host: str("WEB_HOST", "127.0.0.1"),
  },
  engine: {
    signalMinScore: num("SIGNAL_MIN_SCORE", 70),
    minLiquidityUsd: num("MIN_LIQUIDITY_USD", 4000),
    topHoldersCheck: num("TOP_HOLDERS_CHECK", 20),
    smartMoneyWallets: list("SMART_MONEY_WALLETS"),
    /** min realized profit (SOL) on a token before we auto-discover a wallet. */
    discoveryMinProfitSol: num("DISCOVERY_MIN_PROFIT_SOL", 1),
    /** cap on how many wallets we subscribe to (websocket budget). */
    maxWatchedWallets: num("MAX_WATCHED_WALLETS", 300),
    /** funder-cluster bundle check is heavy (many RPC calls); off by default. */
    enableFunderCluster: str("ENABLE_FUNDER_CLUSTER", "0") !== "0",
    /** max tokens analyzed at once; extra launches are dropped under a burst. */
    maxGradingInflight: num("MAX_GRADING_INFLIGHT", 25),
  },
  /** max simultaneous outbound API requests (protects free RPC tiers & the VPN). */
  maxConcurrentRequests: num("MAX_CONCURRENT_REQUESTS", 5),
  live: {
    /** a single buy >= this many SOL counts as a "whale" buy (entry trigger). */
    whaleBuySol: num("WHALE_BUY_SOL", 3),
    /** a single sell >= this many SOL counts as a "whale" dump (exit trigger). */
    whaleSellSol: num("WHALE_SELL_SOL", 3),
    /** max tokens tracked live at once (websocket budget). */
    trackMaxTokens: num("TRACK_MAX_TOKENS", 150),
    /** stop tracking a token after this many minutes of life. */
    trackTtlMin: num("TRACK_TTL_MIN", 45),
    /** sudden market-cap drop (%) within the dump window => EXIT. */
    exitDumpPct: num("EXIT_DUMP_PCT", 30),
  },
  /** entry/exit aggressiveness: conservative | balanced | aggressive | moon.
   *  Default "moon" — the profile that maximised total profit in `npm run sweep`. */
  strategyProfile: str("STRATEGY_PROFILE", "moon"),
  dryRun: str("DRY_RUN", "1") !== "0",
} as const;

export type AppConfig = typeof config;
