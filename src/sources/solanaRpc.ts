import { config } from "../config.js";
import { makeLogger } from "../util/logger.js";
import { limitedFetch } from "../net/limit.js";
import type { MintFacts, HolderFacts } from "../types.js";

const log = makeLogger("solana");

/**
 * Minimal Solana JSON-RPC client using global fetch (Node 20+).
 * We decode the SPL Mint account layout by hand so we don't need the
 * heavyweight @solana/web3.js / spl-token packages.
 */
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await limitedFetch(config.solanaRpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result as T;
}

/**
 * SPL Mint account layout (82 bytes):
 *   0..4   mintAuthorityOption (u32 LE)  — 0 means "None" => renounced
 *   4..36  mintAuthority pubkey
 *   36..44 supply (u64 LE)
 *   44     decimals (u8)
 *   45     isInitialized (u8)
 *   46..50 freezeAuthorityOption (u32 LE) — 0 means "None" => can't freeze
 *   50..82 freezeAuthority pubkey
 */
export async function getMintFacts(mint: string): Promise<MintFacts | null> {
  try {
    const result = await rpc<{
      value: { data: [string, string] } | null;
    }>("getAccountInfo", [mint, { encoding: "base64" }]);
    if (!result?.value) return null;
    const buf = Buffer.from(result.value.data[0], "base64");
    if (buf.length < 82) return null;

    const mintAuthOption = buf.readUInt32LE(0);
    const decimals = buf.readUInt8(44);
    const supplyRaw = buf.readBigUInt64LE(36);
    const freezeAuthOption = buf.readUInt32LE(46);

    const supply = Number(supplyRaw) / 10 ** decimals;

    return {
      mint,
      mintAuthorityRenounced: mintAuthOption === 0,
      freezeAuthorityRenounced: freezeAuthOption === 0,
      decimals,
      supply,
    };
  } catch (e) {
    log.warn(`getMintFacts(${mint.slice(0, 6)}…) failed:`, (e as Error).message);
    return null;
  }
}

/** Top token accounts by balance, plus a rough concentration read. */
export async function getHolderFacts(
  mint: string,
  topN = 20,
): Promise<HolderFacts | null> {
  try {
    const supplyRes = await rpc<{ value: { uiAmount: number | null } }>(
      "getTokenSupply",
      [mint],
    );
    const supply = supplyRes?.value?.uiAmount ?? 0;
    if (!supply) return null;

    const largest = await rpc<{
      value: { address: string; uiAmount: number | null }[];
    }>("getTokenLargestAccounts", [mint]);

    const list = (largest?.value ?? [])
      .map((h) => ({
        owner: h.address,
        amount: h.uiAmount ?? 0,
        pct: ((h.uiAmount ?? 0) / supply) * 100,
      }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, topN);

    const top10Pct = list.slice(0, 10).reduce((s, h) => s + h.pct, 0);
    const topHolderPct = list[0]?.pct ?? 0;

    return {
      mint,
      topHolders: list,
      topHolderPct,
      top10Pct,
      holderCount: null, // requires an indexer (Helius/Birdeye) for the true count
    };
  } catch (e) {
    log.warn(`getHolderFacts(${mint.slice(0, 6)}…) failed:`, (e as Error).message);
    return null;
  }
}

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/**
 * Resolve the *owning program* of each address via getMultipleAccounts.
 * A normal user wallet is owned by the System Program; anything else
 * (bonding curve, AMM pool, escrow) is a PDA we treat as infrastructure.
 * Returns addr -> programId | null (null = account not found / no data).
 */
export async function getAccountOwners(
  addresses: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (let i = 0; i < addresses.length; i += 100) {
    const batch = addresses.slice(i, i + 100);
    try {
      const res = await rpc<{ value: ({ owner: string } | null)[] }>(
        "getMultipleAccounts",
        [batch, { encoding: "base64" }],
      );
      res.value.forEach((acc, idx) => out.set(batch[idx], acc?.owner ?? null));
    } catch (e) {
      log.warn("getAccountOwners batch failed:", (e as Error).message);
      for (const a of batch) out.set(a, null);
    }
  }
  return out;
}

