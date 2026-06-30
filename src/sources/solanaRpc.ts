import { config } from "../config.js";
import { makeLogger } from "../util/logger.js";
import type { MintFacts, HolderFacts } from "../types.js";

const log = makeLogger("solana");

/**
 * Minimal Solana JSON-RPC client using global fetch (Node 20+).
 * We decode the SPL Mint account layout by hand so we don't need the
 * heavyweight @solana/web3.js / spl-token packages.
 */
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(config.solanaRpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result as T;
}

// ----- base58 (decode only, for reading 32-byte pubkeys back to strings) -----
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bytesToBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
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

/** Resolve the on-chain owner of a token account (used for clustering). */
export async function getTokenAccountOwner(addr: string): Promise<string | null> {
  try {
    const res = await rpc<{
      value: { data: { parsed?: { info?: { owner?: string } } } } | null;
    }>("getAccountInfo", [addr, { encoding: "jsonParsed" }]);
    return res?.value?.data?.parsed?.info?.owner ?? null;
  } catch {
    return null;
  }
}

export const _internals = { bytesToBase58 };
