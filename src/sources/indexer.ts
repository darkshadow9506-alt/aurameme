import { config } from "../config.js";
import { makeLogger } from "../util/logger.js";
import { getAccountOwners, SYSTEM_PROGRAM } from "./solanaRpc.js";
import type { HolderFacts } from "../types.js";

const log = makeLogger("indexer");

export const hasHelius = () => Boolean(config.heliusApiKey);
export const hasBirdeye = () => Boolean(config.birdeyeApiKey);

const heliusRpc = () =>
  `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;

/**
 * Programs that legitimately hold large token balances (liquidity / bonding
 * curve / aggregator vaults). Holdings sitting in these are NOT a whale risk,
 * so we exclude them from concentration. A wallet is "real" when its account is
 * owned by the System Program; anything program-owned is treated as infra.
 */
const INFRA_PROGRAMS = new Set<string>([
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // pump.fun
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", // pump.fun AMM (PumpSwap)
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM v4
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // Raydium CLMM
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", // Raydium CPMM
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", // Jupiter
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", // Orca Whirlpools
  "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP", // Orca v2
]);

interface HeliusTokenAccount {
  address: string;
  owner: string;
  amount: number | string;
}

/**
 * Accurate holder stats via Helius DAS `getTokenAccounts` (paginated), with
 * LP/curve accounts excluded from concentration. Falls back to Birdeye, then
 * returns null so the caller can use the plain-RPC top-20 approximation.
 */
export async function getHolderStats(mint: string): Promise<HolderFacts | null> {
  if (hasHelius()) {
    const viaHelius = await getHolderStatsHelius(mint).catch((e) => {
      log.warn(`helius holders(${mint.slice(0, 6)}…):`, (e as Error).message);
      return null;
    });
    if (viaHelius) return viaHelius;
  }
  if (hasBirdeye()) {
    return getHolderStatsBirdeye(mint).catch((e) => {
      log.warn(`birdeye holders(${mint.slice(0, 6)}…):`, (e as Error).message);
      return null;
    });
  }
  return null;
}

async function getHolderStatsHelius(mint: string): Promise<HolderFacts | null> {
  const byOwner = new Map<string, number>();
  let page = 1;
  const LIMIT = 1000;
  const MAX_PAGES = 10; // up to ~10k holders is plenty for grading

  while (page <= MAX_PAGES) {
    const res = await fetch(heliusRpc(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "holders",
        method: "getTokenAccounts",
        params: { mint, limit: LIMIT, page, options: { showZeroBalance: false } },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as {
      result?: { token_accounts?: HeliusTokenAccount[] };
    };
    const accts = json.result?.token_accounts ?? [];
    for (const a of accts) {
      const amt = Number(a.amount) || 0;
      if (amt > 0) byOwner.set(a.owner, (byOwner.get(a.owner) ?? 0) + amt);
    }
    if (accts.length < LIMIT) break;
    page++;
  }

  if (byOwner.size === 0) return null;

  const ranked = [...byOwner.entries()]
    .map(([owner, amount]) => ({ owner, amount }))
    .sort((a, b) => b.amount - a.amount);

  // Classify the top ~25 owners as real-wallet vs infra (LP/curve).
  const topForCheck = ranked.slice(0, 25).map((r) => r.owner);
  const owners = await getAccountOwners(topForCheck);
  const isInfra = (owner: string) => {
    const prog = owners.get(owner);
    if (prog == null) return false; // unknown / plain wallet that never held SOL
    if (prog === SYSTEM_PROGRAM) return false;
    return true; // any program-owned account => pool/curve/escrow
  };

  const total = ranked.reduce((s, r) => s + r.amount, 0);
  let lpCurveAmt = 0;
  const realRanked: { owner: string; amount: number; pct: number; infra?: boolean }[] = [];
  for (const r of ranked) {
    const infra = realRanked.length < 25 ? isInfra(r.owner) : false;
    if (infra) {
      lpCurveAmt += r.amount;
      continue;
    }
    realRanked.push({ owner: r.owner, amount: r.amount, pct: 0, infra: false });
    if (realRanked.length >= 25) break;
  }
  // pct is relative to *real* (non-infra) circulating supply
  const realTotal = total - lpCurveAmt || 1;
  for (const r of realRanked) r.pct = (r.amount / realTotal) * 100;

  const top10Pct = realRanked.slice(0, 10).reduce((s, r) => s + r.pct, 0);
  const topHolderPct = realRanked[0]?.pct ?? 0;
  // exclude infra owners from the holder count
  const infraOwners = topForCheck.filter((o) => isInfra(o)).length;
  const holderCount = byOwner.size - infraOwners;

  return {
    mint,
    topHolders: realRanked,
    topHolderPct,
    top10Pct,
    holderCount,
    lpCurvePct: total > 0 ? (lpCurveAmt / total) * 100 : null,
    source: "indexer",
  };
}

interface BirdeyeSecurity {
  data?: {
    top10HolderPercent?: number;
    top10HolderBalance?: number;
    totalSupply?: number;
    creatorPercentage?: number;
    holderCount?: number;
  };
}

async function getHolderStatsBirdeye(mint: string): Promise<HolderFacts | null> {
  const headers = { "X-API-KEY": config.birdeyeApiKey, "x-chain": "solana" };
  const [secRes, ovRes] = await Promise.all([
    fetch(`https://public-api.birdeye.so/defi/token_security?address=${mint}`, { headers }),
    fetch(`https://public-api.birdeye.so/defi/token_overview?address=${mint}`, { headers }),
  ]);
  const sec = (secRes.ok ? await secRes.json() : {}) as BirdeyeSecurity;
  const ov = (ovRes.ok ? await ovRes.json() : {}) as { data?: { holder?: number } };

  const top10 = sec.data?.top10HolderPercent;
  const holderCount = ov.data?.holder ?? sec.data?.holderCount ?? null;
  if (top10 == null && holderCount == null) return null;

  // Birdeye returns a fraction (0-1) for percentages; clamp defensively so a
  // format surprise can never produce an absurd value that skews scoring.
  const top10Pct = top10 != null ? Math.min(100, Math.max(0, top10 * 100)) : 0;
  const creatorPct =
    sec.data?.creatorPercentage != null
      ? Math.min(100, Math.max(0, sec.data.creatorPercentage * 100))
      : 0;
  return {
    mint,
    topHolders: [],
    topHolderPct: creatorPct,
    top10Pct,
    holderCount,
    lpCurvePct: null,
    source: "indexer",
  };
}

// ---------------------------------------------------------------------------
// Funder clustering: the strongest "this launch was bundled" tell.
// We find the wallet that first sent SOL to each early buyer; if many early
// buyers were funded by the SAME wallet, they're a coordinated cluster.
// ---------------------------------------------------------------------------
export interface ClusterResult {
  largestCluster: number;
  funderGroups: number;
}

export async function clusterEarlyBuyers(
  wallets: string[],
): Promise<ClusterResult | null> {
  if (!hasHelius() || wallets.length === 0) return null;
  const capped = wallets.slice(0, 25); // bound the work
  const funders = new Map<string, number>(); // funder -> count

  await Promise.all(
    capped.map(async (w) => {
      const funder = await getEarliestFunder(w).catch(() => null);
      if (funder) funders.set(funder, (funders.get(funder) ?? 0) + 1);
    }),
  );

  if (funders.size === 0) return null;
  const largestCluster = Math.max(...funders.values());
  return { largestCluster, funderGroups: funders.size };
}

/** Best-effort: who first funded this (likely fresh) wallet with SOL? */
async function getEarliestFunder(wallet: string): Promise<string | null> {
  const sigsRes = await fetch(heliusRpc(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "sigs",
      method: "getSignaturesForAddress",
      params: [wallet, { limit: 1000 }],
    }),
  });
  if (!sigsRes.ok) return null;
  const sigs = ((await sigsRes.json()) as { result?: { signature: string }[] }).result ?? [];
  if (sigs.length === 0 || sigs.length >= 1000) return null; // empty or too active to be a fresh bundle wallet
  const oldest = sigs[sigs.length - 1].signature;

  const txRes = await fetch(heliusRpc(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "tx",
      method: "getTransaction",
      params: [oldest, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }],
    }),
  });
  if (!txRes.ok) return null;
  const tx = (await txRes.json()) as {
    result?: {
      transaction?: { message?: { instructions?: any[] } };
      meta?: { innerInstructions?: { instructions?: any[] }[] };
    };
  };
  const ixs: any[] = [
    ...(tx.result?.transaction?.message?.instructions ?? []),
    ...(tx.result?.meta?.innerInstructions?.flatMap((i) => i.instructions ?? []) ?? []),
  ];
  for (const ix of ixs) {
    const info = ix?.parsed?.info;
    if (
      ix?.program === "system" &&
      (ix?.parsed?.type === "transfer" || ix?.parsed?.type === "transferChecked") &&
      info?.destination === wallet &&
      info?.source &&
      info.source !== wallet
    ) {
      return info.source as string;
    }
  }
  return null;
}
