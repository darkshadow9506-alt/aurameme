/**
 * Backtest CLI.
 *
 *   npm run backtest                 # synthetic dataset (runs out of the box)
 *   npm run backtest -- data.json    # your own exported BtToken[] history
 *   npm run backtest -- --count 500  # bigger synthetic run
 *
 * It replays each token through the live entry/exit strategy and prints how the
 * managed strategy (TP ladder + trailing + stop + dump-protection exits) would
 * have done versus naive buy-and-hold.
 */
import { runBacktest } from "./simulate.js";
import { generateDataset, loadDataset } from "./fixtures.js";

function bar(v: number, max: number, width = 24) {
  const n = Math.max(0, Math.min(width, Math.round((v / max) * width)));
  return "█".repeat(n) + "·".repeat(width - n);
}

async function main() {
  const args = process.argv.slice(2);
  const fileArg = args.find((a) => !a.startsWith("--"));
  const countArg = args.includes("--count") ? Number(args[args.indexOf("--count") + 1]) : 250;

  const tokens = fileArg ? await loadDataset(fileArg) : generateDataset(countArg);
  const source = fileArg ? fileArg : `synthetic (${countArg} tokens, seed 42)`;

  const s = runBacktest(tokens);

  console.log(`\n🔮 AuraMeme backtest — ${source}\n${"─".repeat(52)}`);
  console.log(`Tokens in set     : ${s.tokens}`);
  console.log(`Positions taken   : ${s.traded}  (rest were no-entry / AVOID)`);
  console.log(`Win rate          : ${(s.winRate * 100).toFixed(1)}%  (${s.wins}W / ${s.losses}L)`);
  console.log(`Avg result        : ${s.avgStrategy.toFixed(2)}x   (buy&hold: ${s.avgBuyHold.toFixed(2)}x)`);
  console.log(`Median result     : ${s.medianStrategy.toFixed(2)}x`);
  console.log(`Total PnL (risked): ${s.totalStrategyPnL >= 0 ? "+" : ""}${s.totalStrategyPnL.toFixed(1)}R   (buy&hold: ${s.totalBuyHoldPnL >= 0 ? "+" : ""}${s.totalBuyHoldPnL.toFixed(1)}R)`);
  if (s.best) console.log(`Best trade        : ${s.best.strategy.toFixed(2)}x  ${s.best.name ?? s.best.mint}`);
  if (s.worst) console.log(`Worst trade       : ${s.worst.strategy.toFixed(2)}x  ${s.worst.name ?? s.worst.mint}  (${s.worst.exitReason})`);

  // outcome distribution
  const buckets: Record<string, number> = { "rug-saved (>0.5x)": 0, "loss (<0.7x)": 0, "scratch": 0, "2x+": 0, "5x+": 0 };
  for (const r of s.results) {
    if (!r.traded) continue;
    if (r.strategy >= 5) buckets["5x+"]++;
    else if (r.strategy >= 2) buckets["2x+"]++;
    else if (r.strategy < 0.7) buckets["loss (<0.7x)"]++;
    else if (r.strategy >= 0.7 && r.strategy <= 1.3) buckets["scratch"]++;
    if (r.buyHold < 0.1 && r.strategy > 0.5) buckets["rug-saved (>0.5x)"]++;
  }
  const max = Math.max(1, ...Object.values(buckets));
  console.log(`\nOutcome distribution`);
  for (const [k, v] of Object.entries(buckets)) console.log(`  ${k.padEnd(20)} ${bar(v, max)} ${v}`);

  console.log(
    `\nReading it: "total PnL in R" = sum of profit per trade in units of the size you risked. ` +
      `The strategy's edge over buy&hold comes from banking take-profits and exiting on smart-money/rug triggers — ` +
      `that's what turns the many rugs into partial saves instead of total losses.`,
  );
  console.log(`\n⚠️ Synthetic/illustrative unless you pass real history. Past results never guarantee future trades.\n`);
}

main().catch((e) => {
  console.error("backtest failed:", e);
  process.exit(1);
});
