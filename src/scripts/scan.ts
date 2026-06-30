/**
 * One-off analyzer: `npm run scan -- <mint>`
 * Prints a full safety + opportunity report for a single token and exits.
 * Handy for testing your RPC/API setup without running the whole bot.
 */
import { engine } from "../engine.js";
import { formatShort } from "../telegram/format.js";

async function main() {
  const mint = process.argv[2];
  if (!mint) {
    console.error("Usage: npm run scan -- <mint address>");
    process.exit(1);
  }
  const a = await engine.analyzeMint(mint);
  console.log("\n" + formatShort(a) + "\n");
  console.log("Verdict :", a.verdict, `(${a.score}/100)`);
  console.log("Mint    :", a.mint);
  if (a.mintFacts) {
    console.log("Freeze  :", a.mintFacts.freezeAuthorityRenounced ? "renounced ✅" : "LIVE 🛑 (can freeze you)");
    console.log("Mint au :", a.mintFacts.mintAuthorityRenounced ? "renounced ✅" : "LIVE ⚠️ (can dilute)");
  }
  if (a.holderFacts) {
    console.log(
      "Holders :",
      a.holderFacts.holderCount ?? "—",
      `(${a.holderFacts.source ?? "rpc"})`,
      "| top:",
      a.holderFacts.topHolderPct.toFixed(1) + "%",
      "| top10:",
      a.holderFacts.top10Pct.toFixed(1) + "%",
      a.holderFacts.lpCurvePct != null ? `| LP/curve: ${a.holderFacts.lpCurvePct.toFixed(1)}%` : "",
    );
  }
  if (a.bundleFacts && a.bundleFacts.funderClusterSize != null) {
    console.log("Bundle  :", `${a.bundleFacts.funderClusterSize} buyers share 1 funder`, `(${a.bundleFacts.funderGroups} funder groups)`);
  }
  if (a.marketFacts) {
    console.log("Liquid  :", a.marketFacts.liquidityUsd, "| MC:", a.marketFacts.marketCapUsd);
  }
  console.log("\nRed flags:");
  for (const f of a.redFlags) console.log(`  🔴 [${f.severity}] ${f.message}`);
  console.log("\nGreen flags:");
  for (const g of a.greenFlags) console.log(`  🟢 ${g}`);
  console.log("\nEntry:", a.entry.shouldEnter ? "YES" : "WAIT", "-", a.entry.reason);
  console.log("Take profit:", a.exit.takeProfits.map((t) => `${t.multiple}x→${t.sellPct}%`).join(", "));
  console.log("Stop:", `-${a.exit.stopLossPct}%`, "| Trailing:", `-${a.exit.trailingStopPct}%`);
  console.log("Exit triggers:");
  for (const t of a.exit.exitTriggers) console.log("  •", t);
  console.log();
  process.exit(0);
}

main().catch((e) => {
  console.error("scan failed:", e);
  process.exit(1);
});
