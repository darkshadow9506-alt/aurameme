import type { Alert, Analysis } from "../types.js";
import type { UserPosition } from "../store/store.js";
import { usd, pct, shortAddr } from "../util/format.js";

const VERDICT_EMOJI: Record<Analysis["verdict"], string> = {
  AVOID: "🛑",
  RISKY: "⚠️",
  WATCH: "👀",
  SIGNAL: "✅",
  STRONG_SIGNAL: "🚀",
};

function esc(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
}

/** HTML-formatted Telegram message for a graded token. */
export function formatSignal(a: Analysis): string {
  const m = a.marketFacts;
  const lines: string[] = [];
  const head = a.conviction ? "🔥 HIGH-CONVICTION SIGNAL" : VERDICT_EMOJI[a.verdict];
  const title = `${head} <b>${esc(a.name ?? a.symbol ?? "Unknown")}</b>` +
    (a.symbol ? ` <code>$${esc(a.symbol)}</code>` : "");
  lines.push(title);
  lines.push(`Verdict: <b>${a.verdict.replace("_", " ")}</b>  •  Score: <b>${a.score}/100</b>`);
  lines.push(`<code>${a.mint}</code>`);
  if (a.convictionReasons.length) {
    lines.push("");
    lines.push("<b>Why this passed the filter:</b>");
    for (const r of a.convictionReasons) lines.push(esc(r));
  }
  lines.push("");

  // market snapshot
  if (m) {
    lines.push("📊 <b>Market</b>");
    lines.push(
      `Price ${m.priceUsd ? `$${m.priceUsd.toPrecision(3)}` : "—"}  •  Liq ${usd(m.liquidityUsd)}  •  MC ${usd(m.marketCapUsd)}`,
    );
    lines.push(
      `Vol24h ${usd(m.volume24hUsd)}  •  1h ${pct(m.priceChange.h1)}  •  Buys/Sells ${m.buys24h ?? "—"}/${m.sells24h ?? "—"}`,
    );
    if (a.holderFacts?.holderCount != null)
      lines.push(
        `Holders ${a.holderFacts.holderCount}  •  Top holder ${a.holderFacts.topHolderPct.toFixed(1)}%  •  Top10 ${a.holderFacts.top10Pct.toFixed(1)}%`,
      );
    lines.push("");
  }

  // safety
  if (a.greenFlags.length) {
    lines.push("🟢 <b>Good</b>");
    for (const g of a.greenFlags) lines.push(`• ${esc(g)}`);
    lines.push("");
  }
  if (a.redFlags.length) {
    lines.push("🔴 <b>Red flags</b>");
    for (const f of a.redFlags.slice(0, 6))
      lines.push(`• [${f.severity}] ${esc(f.message)}`);
    lines.push("");
  }

  // smart money
  if (a.smartMoney.length) {
    lines.push("🧠 <b>Smart money</b>");
    for (const s of a.smartMoney.slice(0, 5))
      lines.push(
        `• ${s.action.toUpperCase()} by ${esc(s.label)} ${shortAddr(s.wallet)} (win ${(s.winRate * 100).toFixed(0)}%)`,
      );
    lines.push("");
  }

  // plan
  lines.push("🎯 <b>Plan</b>");
  lines.push(`Entry: ${a.entry.shouldEnter ? "YES" : "WAIT"} — ${esc(a.entry.reason)}`);
  if (a.entry.shouldEnter)
    lines.push(`Max size: ${a.entry.maxPositionPct}% of memecoin budget`);
  lines.push(
    "Take profit: " +
      a.exit.takeProfits.map((t) => `${t.multiple}x→sell ${t.sellPct}%`).join(", "),
  );
  lines.push(`Stop loss: -${a.exit.stopLossPct}%  •  Trailing: -${a.exit.trailingStopPct}% from peak`);
  lines.push("Exit triggers:");
  for (const t of a.exit.exitTriggers.slice(0, 4)) lines.push(`• ${esc(t)}`);
  lines.push("");

  // links
  const links: string[] = [];
  if (m?.url) links.push(`<a href="${m.url}">Chart</a>`);
  links.push(`<a href="https://pump.fun/${a.mint}">pump.fun</a>`);
  links.push(`<a href="https://jup.ag/swap/SOL-${a.mint}">Trade on Jupiter</a>`);
  links.push(`<a href="https://solscan.io/token/${a.mint}">Solscan</a>`);
  lines.push(links.join("  •  "));
  lines.push("");
  lines.push("<i>Not financial advice. Memecoins are extreme risk — only money you can lose.</i>");

  return lines.join("\n");
}

const ALERT_EMOJI: Record<Alert["kind"], string> = {
  ENTRY: "🟢🐳",
  ACCUMULATION: "➕",
  EXIT: "🔴🚨",
  EXIT_WARNING: "⚠️",
};

/** Compact, push-friendly live alert message. */
export function formatAlert(al: Alert): string {
  const head =
    al.kind === "ENTRY"
      ? "ENTRY — buy signal"
      : al.kind === "EXIT"
        ? "EXIT — sell now"
        : al.kind === "ACCUMULATION"
          ? "Accumulation"
          : "Exit warning";
  const lines: string[] = [];
  lines.push(`${ALERT_EMOJI[al.kind]} <b>${esc(head)}</b>`);
  lines.push(`<b>${esc(al.name ?? al.symbol ?? "token")}</b>${al.symbol ? ` $${esc(al.symbol)}` : ""}`);
  if (al.verdict)
    lines.push(`Safety grade: <b>${al.verdict.replace("_", " ")}</b> (${al.score ?? "—"}/100)`);
  lines.push(esc(al.reason));
  const bits: string[] = [];
  if (al.changeFromEntryPct != null) bits.push(`from entry ${pct(al.changeFromEntryPct)}`);
  if (al.changeFromPeakPct != null && al.changeFromPeakPct < 0)
    bits.push(`from peak ${pct(al.changeFromPeakPct)}`);
  if (bits.length) lines.push(bits.join("  •  "));
  lines.push(`<code>${al.mint}</code>`);
  const links = [`<a href="https://jup.ag/swap/SOL-${al.mint}">Trade · Jupiter</a>`, `<a href="https://pump.fun/${al.mint}">pump.fun</a>`];
  lines.push(links.join("  •  "));
  return lines.join("\n");
}

/**
 * Personalized, precise sell plan once a user taps "I'm in". Everything is in
 * multiples of THEIR entry (what they watch as P&L %), plus absolute SOL market
 * caps when we know their entry, so it's unambiguous where to sell.
 */
export function formatExitPlan(pos: UserPosition, currentMcapSol?: number | null): string {
  const e = pos.entryMcapSol;
  const lines: string[] = [];
  lines.push(`📋 <b>Your sell plan — ${esc(pos.name ?? pos.symbol ?? "token")}</b>`);
  if (e > 0) lines.push(`Entry market cap: <b>${e.toFixed(1)} SOL</b>`);
  if (currentMcapSol && e > 0) {
    const x = currentMcapSol / e;
    lines.push(`Now: ${currentMcapSol.toFixed(1)} SOL (${pct((x - 1) * 100)})`);
  }
  lines.push("");
  lines.push("🎯 <b>Take profit — sell in pieces:</b>");
  for (const t of pos.takeProfits) {
    const at = e > 0 ? ` (≈ ${(e * t.multiple).toFixed(0)} SOL mc)` : "";
    const plusPct = `+${Math.round((t.multiple - 1) * 100)}%`;
    lines.push(`• at <b>${t.multiple}x</b> (${plusPct})${at} → sell <b>${t.sellPct}%</b>`);
  }
  lines.push("• keep the rest as a moonbag on the trailing stop");
  lines.push("");
  lines.push("🛡️ <b>Protect:</b>");
  lines.push(`• Stop-loss: <b>-${pos.stopLossPct}%</b>${e > 0 ? ` (≈ ${(e * (1 - pos.stopLossPct / 100)).toFixed(0)} SOL mc)` : ""}`);
  lines.push(`• After the first take-profit, move your stop to <b>break-even</b> (your entry) — then it can't become a loss.`);
  lines.push(`• Trailing stop: once in profit, exit if it drops <b>${pos.trailingStopPct}%</b> from its peak.`);
  lines.push("");
  lines.push("🔔 I'll ping you here the moment a dump, a smart-money exit, or your stop triggers.");
  lines.push("");
  lines.push(`<a href="https://jup.ag/swap/${pos.mint}-SOL">Sell on Jupiter</a>  •  <a href="https://pump.fun/${pos.mint}">pump.fun</a>`);
  lines.push("<i>Not financial advice. Take profits — nobody went broke booking gains.</i>");
  return lines.join("\n");
}

/** Personalized EXIT ping for a user who is in this position. */
export function formatUserExit(pos: UserPosition, al: Alert, currentMcapSol?: number | null): string {
  const e = pos.entryMcapSol;
  const lines: string[] = [];
  lines.push(`🔴🚨 <b>EXIT — ${esc(pos.name ?? pos.symbol ?? "token")}</b>`);
  if (currentMcapSol && e > 0) {
    const x = currentMcapSol / e;
    lines.push(`Your P&L: <b>${pct((x - 1) * 100)}</b> (entry ${e.toFixed(1)} → ${currentMcapSol.toFixed(1)} SOL mc)`);
  }
  lines.push(esc(al.reason));
  lines.push(`<a href="https://jup.ag/swap/${pos.mint}-SOL">Sell on Jupiter now</a>`);
  return lines.join("\n");
}

export function formatShort(a: Analysis): string {
  return `${VERDICT_EMOJI[a.verdict]} ${a.verdict.replace("_", " ")} ${a.score}/100 — ${a.symbol ?? a.mint.slice(0, 8)} (${usd(a.marketFacts?.liquidityUsd)} liq)`;
}
