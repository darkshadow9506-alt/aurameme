/**
 * Parameter sweep: backtests every strategy profile on the same dataset so we
 * can pick the one that maximizes profit instead of guessing.
 *
 *   npm run sweep                 # synthetic dataset
 *   npm run sweep -- data.json    # your own history
 *   npm run sweep -- --count 800
 */
import { runBacktest } from "./simulate.js";
import { generateDataset, loadDataset } from "./fixtures.js";
import { PROFILES } from "../signals/profiles.js";

async function main() {
  const args = process.argv.slice(2);
  const fileArg = args.find((a) => !a.startsWith("--"));
  const countArg = args.includes("--count") ? Number(args[args.indexOf("--count") + 1]) : 400;
  const tokens = fileArg ? await loadDataset(fileArg) : generateDataset(countArg, 7);
  const source = fileArg ? fileArg : `synthetic (${countArg} tokens)`;

  console.log(`\n🔮 AuraMeme profile sweep — ${source}\n${"─".repeat(78)}`);
  console.log(
    ["profile".padEnd(13), "trades".padStart(7), "win%".padStart(7), "avg".padStart(7), "median".padStart(7), "totalPnL(R)".padStart(13), "best".padStart(8)].join(" "),
  );
  console.log("─".repeat(78));

  const rows = Object.values(PROFILES).map((p) => {
    const s = runBacktest(tokens, p);
    return { p, s };
  });

  // rank by total profit (the "most profit" objective)
  rows.sort((a, b) => b.s.totalStrategyPnL - a.s.totalStrategyPnL);

  for (const { p, s } of rows) {
    console.log(
      [
        p.name.padEnd(13),
        String(s.traded).padStart(7),
        (s.winRate * 100).toFixed(1).padStart(7),
        s.avgStrategy.toFixed(2).padStart(7),
        s.medianStrategy.toFixed(2).padStart(7),
        (s.totalStrategyPnL >= 0 ? "+" : "") + s.totalStrategyPnL.toFixed(1).padStart(12),
        (s.best ? s.best.strategy.toFixed(1) + "x" : "—").padStart(8),
      ].join(" "),
    );
  }

  const winner = rows[0];
  console.log("─".repeat(78));
  console.log(
    `🏆 Most total profit: "${winner.p.name}"  →  +${winner.s.totalStrategyPnL.toFixed(1)}R ` +
      `(win ${(winner.s.winRate * 100).toFixed(0)}%, avg ${winner.s.avgStrategy.toFixed(2)}x).`,
  );
  console.log(
    `   Set it with STRATEGY_PROFILE=${winner.p.name} in .env (or leave the default).`,
  );
  console.log(
    `\nNote: "most profit" usually means lower win-rate + a few fat winners. If you want\n` +
      `steadier wins, pick "conservative"/"balanced". Synthetic data — illustrative only.\n`,
  );
}

main().catch((e) => {
  console.error("sweep failed:", e);
  process.exit(1);
});
