import type { PumpEvent, BundleFacts } from "../types.js";

/**
 * Insider / sniper "bundle" detection.
 *
 * On pump.fun a classic insider play is: the dev (or a coordinated group) buys
 * a large chunk of supply in the first block(s) using many freshly-funded
 * wallets, then dumps on retail. We approximate this from the early trade flow:
 *
 *   - earlyBuyerCount  : distinct wallets that bought in the launch window
 *   - sniperSupplyPct  : share of supply those early buyers grabbed
 *   - clusterCount     : how many *near-identical* buys happened in the very
 *                        first second(s) — a strong "bundled" tell
 *
 * This is heuristic: it flags suspicious launches, it does not prove intent.
 */

/** Collects the first trades of a token for a short window, then scores them. */
export class EarlyTradeCollector {
  private map = new Map<
    string,
    { createdAt: number; events: PumpEvent[]; done: boolean }
  >();

  open(mint: string, createdAt = Date.now()) {
    if (!this.map.has(mint))
      this.map.set(mint, { createdAt, events: [], done: false });
  }

  push(ev: PumpEvent) {
    const rec = this.map.get(ev.mint);
    if (rec && !rec.done) rec.events.push(ev);
  }

  /** Finalize and return the bundle facts; frees memory. */
  finalize(mint: string): BundleFacts {
    const rec = this.map.get(mint);
    this.map.delete(mint);
    if (!rec) return { mint, earlyBuyerCount: 0, sniperSupplyPct: 0, clusterCount: 0 };
    rec.done = true;
    return analyzeEarlyTrades(mint, rec.createdAt, rec.events);
  }

  has(mint: string) {
    return this.map.has(mint);
  }
}

export function analyzeEarlyTrades(
  mint: string,
  createdAt: number,
  events: PumpEvent[],
): BundleFacts {
  const buys = events.filter((e) => e.txType === "buy");
  const byWallet = new Map<string, number>(); // wallet -> token amount
  let totalTokensBought = 0;

  // "bundle window": buys landing within 1.5s of creation look automated
  const BUNDLE_WINDOW_MS = 1500;
  let bundledBuys = 0;

  for (const e of buys) {
    const w = e.traderPublicKey ?? "unknown";
    const amt = e.tokenAmount ?? 0;
    byWallet.set(w, (byWallet.get(w) ?? 0) + amt);
    totalTokensBought += amt;
    if (e.receivedAt - createdAt <= BUNDLE_WINDOW_MS) bundledBuys++;
  }

  // Supply captured by the snipers, relative to the pump.fun virtual supply.
  // pump.fun tokens have a fixed 1B supply; the bonding curve holds most of it
  // initially, so we express sniper share against the typical 1B mint.
  const PUMP_TOTAL_SUPPLY = 1_000_000_000;
  const sniperSupplyPct = Math.min(
    100,
    (totalTokensBought / PUMP_TOTAL_SUPPLY) * 100,
  );

  return {
    mint,
    earlyBuyerCount: byWallet.size,
    sniperSupplyPct,
    clusterCount: bundledBuys,
  };
}
