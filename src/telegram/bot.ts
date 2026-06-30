import { Bot } from "grammy";
import { config } from "../config.js";
import { makeLogger } from "../util/logger.js";
import { engine } from "../engine.js";
import { store } from "../store/store.js";
import { tracker } from "../live/tracker.js";
import { formatSignal, formatShort, formatAlert } from "./format.js";

const log = makeLogger("telegram");

const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Telegram interface. Pushes signals to the configured chat ids and answers a
 * handful of commands. If no token is set the bot is disabled gracefully so the
 * rest of the app still runs (useful for web-only / dev mode).
 */
export function startTelegram(): Bot | null {
  if (!config.telegram.token) {
    log.warn("TELEGRAM_BOT_TOKEN not set — Telegram disabled (web/engine still run).");
    return null;
  }

  const bot = new Bot(config.telegram.token);

  bot.command("start", (ctx) =>
    ctx.reply(
      [
        "🔮 <b>AuraMeme</b> — pump.fun signal & safety bot.",
        "",
        "Commands:",
        "/check &lt;mint&gt; — full safety + opportunity analysis of a token",
        "/recent — last graded tokens",
        "/signals — recent tokens that passed the signal threshold",
        "/positions — tokens being tracked live for entry/exit",
        "/wallets — your smart-money watch list",
        "/addwallet &lt;addr&gt; [label] — track a winning trader wallet",
        "/delwallet &lt;addr&gt; — stop tracking a wallet",
        "/help — risk & usage notes",
        "",
        "<i>Not financial advice. Memecoins are extreme risk.</i>",
      ].join("\n"),
      { parse_mode: "HTML" },
    ),
  );

  bot.command("help", (ctx) =>
    ctx.reply(
      [
        "⚠️ <b>Read this.</b>",
        "• No bot can guarantee a coin won't rug or freeze. AuraMeme detects the on-chain risks (freeze/mint authority, whale concentration, bundled snipers) and refuses to signal the obvious traps — but residual risk is always > 0.",
        "• No bot can guarantee you exit before a dump. The exit plan is mechanical risk management (TP ladder + stop + trailing + smart-money exit), not a crystal ball.",
        "• 90%+ of memecoins go to zero. Size every position as money you can lose 100% of.",
        "• Trade from your own self-custody wallet (e.g. Phantom) via Jupiter/Raydium — no KYC, works from anywhere. Run this bot on a VPS outside sanctioned regions so the data APIs don't block it.",
      ].join("\n"),
      { parse_mode: "HTML" },
    ),
  );

  bot.command("check", async (ctx) => {
    const mint = ctx.match.trim();
    if (!SOL_ADDR.test(mint)) return ctx.reply("Usage: /check <mint address>");
    await ctx.reply("⏳ Analyzing…");
    try {
      const a = await engine.analyzeMint(mint);
      await ctx.reply(formatSignal(a), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (e) {
      await ctx.reply(`Failed: ${(e as Error).message}`);
    }
  });

  bot.command("recent", (ctx) => {
    const list = store.recentAnalyses(12);
    if (!list.length) return ctx.reply("No tokens graded yet — give it a minute.");
    return ctx.reply(list.map(formatShort).join("\n"));
  });

  bot.command("signals", (ctx) => {
    const list = store
      .recentAnalyses(60)
      .filter((a) => a.score >= config.engine.signalMinScore)
      .slice(0, 12);
    if (!list.length) return ctx.reply("No qualifying signals recently.");
    return ctx.reply(list.map(formatShort).join("\n"));
  });

  bot.command("positions", (ctx) => {
    const list = tracker.positionsDTO();
    if (!list.length) return ctx.reply("No live positions yet — they open as tokens get tracked.");
    return ctx.reply(
      list
        .slice(0, 25)
        .map((p) => {
          const tag = p.entered ? "🟢in" : "👀watch";
          const chg = p.changeFromEntryPct != null ? ` ${p.changeFromEntryPct >= 0 ? "+" : ""}${p.changeFromEntryPct.toFixed(0)}%` : "";
          return `${tag} ${p.symbol ?? p.mint.slice(0, 8)}${chg} (peak ${p.peakMcapSol.toFixed(0)} SOL mc)`;
        })
        .join("\n"),
    );
  });

  bot.command("wallets", (ctx) => {
    const list = store.allSmart().slice(0, 25);
    if (!list.length) return ctx.reply("No smart-money wallets tracked. Add with /addwallet <addr>.");
    return ctx.reply(
      list
        .map(
          (w) =>
            `${w.label} ${w.wallet.slice(0, 6)}… — pnl ${w.pnlSol.toFixed(2)} SOL, ${w.wins}W/${w.losses}L`,
        )
        .join("\n"),
    );
  });

  bot.command("addwallet", (ctx) => {
    const [addr, ...rest] = ctx.match.trim().split(/\s+/);
    if (!SOL_ADDR.test(addr ?? "")) return ctx.reply("Usage: /addwallet <addr> [label]");
    engine.addSmartWallet(addr, rest.join(" ") || "manual");
    return ctx.reply(`Tracking ${addr.slice(0, 6)}… ✅`);
  });

  bot.command("delwallet", (ctx) => {
    const addr = ctx.match.trim();
    if (!SOL_ADDR.test(addr)) return ctx.reply("Usage: /delwallet <addr>");
    return ctx.reply(engine.removeSmartWallet(addr) ? "Removed ✅" : "Not found.");
  });

  // ---- push signals to subscribers ----
  const pushAll = async (text: string) => {
    for (const id of config.telegram.chatIds) {
      try {
        await bot.api.sendMessage(id, text, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
      } catch (e) {
        log.warn(`push to ${id} failed:`, (e as Error).message);
      }
    }
  };

  engine.on("signal", (a) => void pushAll(formatSignal(a)));
  // live entry/exit alerts — the core "buy when whales buy / sell when they dump"
  engine.on("alert", (al) => void pushAll(formatAlert(al)));

  bot.catch((err) => log.error("bot error:", err.message));
  bot.start({ onStart: (i) => log.ok(`Telegram bot @${i.username} online`) });
  return bot;
}
