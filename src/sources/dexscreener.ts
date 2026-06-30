import { config } from "../config.js";
import { makeLogger } from "../util/logger.js";
import { limitedFetch } from "../net/limit.js";
import type { MarketFacts } from "../types.js";

const log = makeLogger("dexscreener");

interface DexPair {
  chainId: string;
  dexId: string;
  url: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  volume?: { h24?: number };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  pairCreatedAt?: number;
  txns?: { h24?: { buys?: number; sells?: number } };
}

/**
 * Pull market data for a mint from DexScreener (free, no key).
 * NOTE: DexScreener may block some sanctioned-country IPs — run the bot on a
 * VPS outside Iran. See README.
 */
export async function getMarketFacts(mint: string): Promise<MarketFacts | null> {
  try {
    const res = await limitedFetch(`${config.dexscreenerBase}/latest/dex/tokens/${mint}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { pairs?: DexPair[] };
    const pairs = (json.pairs ?? []).filter((p) => p.chainId === "solana");
    if (pairs.length === 0) return emptyMarket(mint);

    // pick the deepest-liquidity pair as canonical
    const best = pairs.sort(
      (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
    )[0];

    return {
      mint,
      priceUsd: best.priceUsd ? Number(best.priceUsd) : null,
      liquidityUsd: best.liquidity?.usd ?? null,
      fdvUsd: best.fdv ?? null,
      marketCapUsd: best.marketCap ?? best.fdv ?? null,
      volume24hUsd: best.volume?.h24 ?? null,
      priceChange: best.priceChange ?? {},
      pairCreatedAt: best.pairCreatedAt ?? null,
      buys24h: best.txns?.h24?.buys ?? null,
      sells24h: best.txns?.h24?.sells ?? null,
      dexId: best.dexId ?? null,
      url: best.url ?? null,
    };
  } catch (e) {
    // Fresh pump.fun tokens legitimately have no DexScreener pair yet, so this
    // is expected noise — keep it at debug level.
    log.debug(`getMarketFacts(${mint.slice(0, 6)}…) failed:`, (e as Error).message);
    return emptyMarket(mint);
  }
}

function emptyMarket(mint: string): MarketFacts {
  return {
    mint,
    priceUsd: null,
    liquidityUsd: null,
    fdvUsd: null,
    marketCapUsd: null,
    volume24hUsd: null,
    priceChange: {},
    pairCreatedAt: null,
    buys24h: null,
    sells24h: null,
    dexId: null,
    url: null,
  };
}
