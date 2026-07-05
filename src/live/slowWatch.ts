import { makeLogger } from "../util/logger.js";
import { store } from "../store/store.js";
import { getMarketFacts } from "../sources/dexscreener.js";
import type { Alert } from "../types.js";
import type { MarketFacts } from "../types.js";

const log = makeLogger("slow-watch");

/**
 * Poll-based exit guard for the user's open positions.
 *
 * The fast tracker only sees pump.fun bonding-curve trades; a survivor token
 * that migrated to Raydium/PumpSwap has no stream there. So every open user
 * position is ALSO watched here via DexScreener polling (free), firing:
 *
 *   - rug guard: liquidity collapsed vs entry      → terminal EXIT
 *   - stop-loss: price below entry * (1 - stop%)   → terminal EXIT
 *   - trailing:  in profit, price fell X% off peak → terminal EXIT
 *   - first-TP:  price crossed the first ladder rung → one-time WARNING
 *                ("take the first profit, move stop to break-even")
 *
 * Emits the same Alert shape as the fast tracker so the bot's personalized
 * exit pings + auto-close logic just work.
 */

const POLL_MS = 90_000;
const LIQ_RUG_DROP_PCT = 40;

type Emit = (al: Alert) => void;
type Fetcher = (mint: string) => Promise<MarketFacts | null>;

export class SlowWatch {
  private emit: Emit | null = null;
  private fetcher: Fetcher = getMarketFacts;
  private tpWarned = new Set<string>(); // chatId:mint — first-TP warning sent

  start(emit: Emit, fetcher?: Fetcher) {
    this.emit = emit;
    if (fetcher) this.fetcher = fetcher;
    setInterval(() => void this.tick(), POLL_MS).unref();
    log.ok("slow position watcher on (90s polls via DexScreener)");
  }

  /** One poll pass over all open user positions. Exported for tests. */
  async tick(): Promise<void> {
    if (!this.emit) return;
    const positions = store.allUserPositions();
    // prune first-TP markers for positions that no longer exist, so a future
    // re-entry into the same token gets its warning again
    const liveKeys = new Set(positions.map((p) => `${p.chatId}:${p.mint}`));
    for (const k of this.tpWarned) if (!liveKeys.has(k)) this.tpWarned.delete(k);
    if (!positions.length) return;

    // one fetch per unique mint, shared across users in the same token
    const mints = [...new Set(positions.map((p) => p.mint))];
    for (const mint of mints) {
      let m: MarketFacts | null = null;
      try {
        m = await this.fetcher(mint);
      } catch {
        continue;
      }
      const price = m?.priceUsd ?? null;
      const liq = m?.liquidityUsd ?? null;
      if (price == null || price <= 0) continue;

      for (const pos of positions.filter((p) => p.mint === mint)) {
        this.check(pos.chatId, mint, price, liq);
      }
    }
  }

  private check(chatId: string, mint: string, price: number, liq: number | null) {
    const pos = store.getUserPosition(chatId, mint);
    if (!pos) return;

    // seed USD refs the first time we see prices for this position
    if (pos.entryPriceUsd == null) {
      store.updateUserPosition(chatId, mint, {
        entryPriceUsd: price,
        peakPriceUsd: price,
        entryLiqUsd: liq ?? undefined,
      });
      return;
    }
    const entry = pos.entryPriceUsd;
    const peak = Math.max(pos.peakPriceUsd ?? entry, price);
    if (peak !== pos.peakPriceUsd) store.updateUserPosition(chatId, mint, { peakPriceUsd: peak });
    const x = price / entry;

    const fire = (kind: Alert["kind"], reason: string, terminal: boolean) => {
      this.emit!({
        kind,
        mint,
        symbol: pos.symbol,
        name: pos.name,
        reason,
        at: Date.now(),
        terminal,
        changeFromEntryPct: (x - 1) * 100,
        changeFromPeakPct: peak > 0 ? (price / peak - 1) * 100 : 0,
      });
    };

    // 1) rug guard: liquidity collapsed vs what it was at entry
    if (liq != null && pos.entryLiqUsd && pos.entryLiqUsd > 0) {
      const drop = (1 - liq / pos.entryLiqUsd) * 100;
      if (drop >= LIQ_RUG_DROP_PCT) {
        return fire("EXIT", `🩸 Liquidity down ${drop.toFixed(0)}% since your entry — likely rug/LP pull. Sell NOW.`, true);
      }
    }

    // 2) stop-loss
    if (x <= 1 - pos.stopLossPct / 100) {
      return fire("EXIT", `🛑 Stop-loss: ${((x - 1) * 100).toFixed(0)}% from your entry — cut it.`, true);
    }

    // 3) trailing stop once in profit
    const dropFromPeak = peak > 0 ? (1 - price / peak) * 100 : 0;
    if (x > 1 && dropFromPeak >= pos.trailingStopPct) {
      return fire("EXIT", `📉 Trailing stop: -${dropFromPeak.toFixed(0)}% from the peak — bank the gain.`, true);
    }

    // 4) first take-profit crossed → one-time actionable ping
    const firstTp = pos.takeProfits[0];
    const key = `${chatId}:${mint}`;
    if (firstTp && x >= firstTp.multiple && !this.tpWarned.has(key)) {
      this.tpWarned.add(key);
      fire(
        "EXIT_WARNING",
        `🎯 First target hit (${firstTp.multiple}x): sell ${firstTp.sellPct}% NOW and move your stop to break-even — from here this trade can't lose.`,
        false,
      );
    }
  }
}

export const slowWatch = new SlowWatch();
