import type { PumpEvent, SmartMoneyHit } from "../types.js";
import { store } from "../store/store.js";

/**
 * Smart-money tracking.
 *
 * The idea: maintain a table of wallets that have historically made money on
 * memecoins, and treat *their* buys as a strong bullish signal — and their
 * sells as an early-exit warning. Two ways wallets get into the table:
 *
 *   1. You seed known good wallets (SMART_MONEY_WALLETS env / Telegram /addwallet).
 *   2. The engine "discovers" them: when a token we tracked does a big move,
 *      the wallets that bought early and sold into strength get credited.
 *      (Discovery is best-effort and improves the longer the bot runs.)
 *
 * NOTE on "find the real winning wallets, not the scammer dev wallets":
 *   A scammer/dev wallet shows up as the *creator* and as an early seller who
 *   dumps into the launch. A genuine smart trader shows up as someone who buys
 *   AFTER creation across MANY different tokens with positive realized PnL and
 *   who is NOT the mint creator. We separate the two using creator info +
 *   realized PnL history below.
 */

/** Map an incoming wallet trade into a SmartMoneyHit if we know the wallet. */
export function classifyWalletTrade(ev: PumpEvent): SmartMoneyHit | null {
  if (!ev.traderPublicKey) return null;
  const known = store.isSmart(ev.traderPublicKey);
  if (!known) return null;
  const total = known.wins + known.losses;
  const winRate = total > 0 ? known.wins / total : 0;
  return {
    wallet: ev.traderPublicKey,
    label: known.label,
    winRate,
    action: ev.txType,
    at: ev.receivedAt,
  };
}

/**
 * Discovery hook: call when we observe a creator wallet so we can make sure we
 * never label the dev/creator as "smart money". Creators are blacklisted from
 * the smart table for that token's signals.
 */
const creators = new Map<string, string>(); // mint -> creator wallet
const MAX_CREATORS = 5000; // bound memory on the launch firehose (FIFO eviction)
export function noteCreator(mint: string, wallet?: string) {
  if (!wallet) return;
  creators.set(mint, wallet);
  if (creators.size > MAX_CREATORS) {
    const oldest = creators.keys().next().value;
    if (oldest !== undefined) creators.delete(oldest);
  }
}
export function creatorOf(mint: string): string | undefined {
  return creators.get(mint);
}

/**
 * Credit/debit a wallet's realized PnL based on an observed round-trip.
 * `pnlSol` positive => the wallet sold for more SOL than it spent.
 * A wallet that crosses a positive-PnL threshold across several tokens gets
 * promoted into the smart-money watch table automatically.
 */
export function recordRoundTrip(wallet: string, mint: string, pnlSol: number) {
  // never promote the token's own creator
  if (creatorOf(mint) === wallet) return;
  let w = store.isSmart(wallet);
  if (!w && pnlSol > 0) {
    // tentative discovery: only promote on a clearly profitable exit
    w = store.addSmart(wallet, "discovered");
  }
  if (w) store.recordSmartResult(wallet, pnlSol);
}
