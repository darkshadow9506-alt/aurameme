import { Bot, InlineKeyboard } from "grammy";
import { config } from "../config.js";
import { makeLogger } from "../util/logger.js";
import { engine } from "../engine.js";
import { store } from "../store/store.js";
import { tracker } from "../live/tracker.js";
import { activeProfile } from "../signals/profiles.js";
import { formatSignal, formatShort, formatExitPlan, formatUserExit } from "./format.js";
import type { Analysis, Alert } from "../types.js";

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
        "/mypos — positions you tapped “I'm in” on (with your sell plan)",
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

  // ---- push to subscribers (optionally with an inline keyboard) ----
  const pushAll = async (text: string, keyboard?: InlineKeyboard) => {
    for (const id of config.telegram.chatIds) {
      try {
        await bot.api.sendMessage(id, text, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: keyboard,
        });
      } catch (e) {
        log.warn(`push to ${id} failed:`, (e as Error).message);
      }
    }
  };

  const imInButton = (mint: string) =>
    new InlineKeyboard().text("✅ I'm in — tell me when to sell", `in:${mint}`);

  // Telegram gets ONLY the strict conviction signals (a few a day) with an
  // "I'm in" button — the safest, whale/demand-backed, explosive picks.
  engine.on("signal", (a: Analysis) => void pushAll(formatSignal(a), imInButton(a.mint)));

  // Live exits are pushed ONLY to users who tapped "I'm in" (personalized).
  // No generic entry/exit broadcast — that was the noise.
  engine.on("alert", (al: Alert) => {
    if (al.kind === "EXIT" || al.kind === "EXIT_WARNING") void notifyHolders(al);
  });

  const notifyHolders = async (al: Alert) => {
    // prefer the live read; fall back to the mcap the alert itself carried
    const live = tracker.liveMcapOf(al.mint) ?? al.marketCapSol ?? null;
    for (const pos of store.userPositionsForMint(al.mint)) {
      try {
        await bot.api.sendMessage(pos.chatId, formatUserExit(pos, al, live), {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
        if (al.terminal) store.closeUserPosition(pos.chatId, pos.mint);
      } catch (e) {
        log.warn(`exit ping to ${pos.chatId} failed:`, (e as Error).message);
      }
    }
  };

  // ---- "I'm in" / "Close" buttons ----
  bot.callbackQuery(/^in:(.+)$/, async (ctx) => {
    const mint = ctx.match[1];
    const chatId = String(ctx.chat?.id ?? "");
    await ctx.answerCallbackQuery({ text: "Tracking your position — sell plan below 👇" });
    // make sure the token is live-tracked and its exit triggers are armed
    // (handles taps on older signals and post-restart taps too)
    await engine.ensureTracked(mint);
    const a = store.getAnalysis(mint);
    const prof = activeProfile();
    const entry = tracker.liveMcapOf(mint) ?? a?.bundleFacts?.earlyMarketCapSol ?? 0;
    store.openUserPosition({
      chatId,
      mint,
      symbol: a?.symbol,
      name: a?.name,
      entryMcapSol: entry,
      entryAt: Date.now(),
      stopLossPct: a?.exit.stopLossPct ?? prof.stopLossBase,
      trailingStopPct: a?.exit.trailingStopPct ?? prof.trailingStopPct,
      takeProfits: a?.exit.takeProfits ?? prof.takeProfits,
      peakMcapSol: entry,
    });
    const pos = store.getUserPosition(chatId, mint)!;
    await ctx.reply(formatExitPlan(pos, tracker.liveMcapOf(mint)), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard().text("❌ I sold / close", `out:${mint}`),
    });
  });

  bot.callbackQuery(/^out:(.+)$/, async (ctx) => {
    const mint = ctx.match[1];
    const chatId = String(ctx.chat?.id ?? "");
    const ok = store.closeUserPosition(chatId, mint);
    await ctx.answerCallbackQuery({ text: ok ? "Closed ✅" : "No open position." });
  });

  bot.command("mypos", (ctx) => {
    const list = store.userPositionsForChat(String(ctx.chat.id));
    if (!list.length) return ctx.reply("You have no open positions. Tap “I'm in” on a signal to track one.");
    return ctx.reply(
      list
        .map((p) => {
          const live = tracker.liveMcapOf(p.mint);
          const chg = live && p.entryMcapSol > 0 ? ` (${live / p.entryMcapSol >= 1 ? "+" : ""}${(((live / p.entryMcapSol) - 1) * 100).toFixed(0)}%)` : "";
          return `• ${p.symbol ?? p.mint.slice(0, 8)} — entry ${p.entryMcapSol.toFixed(0)} SOL mc${chg}`;
        })
        .join("\n"),
    );
  });

  bot.catch((err) => log.error("bot error:", err.message));
  // bot.start() long-polls; if the token is invalid it rejects — catch it so a
  // bad token doesn't crash the whole process (engine + web keep running).
  bot
    .start({ onStart: (i) => log.ok(`Telegram bot @${i.username} online`) })
    .catch((e) => log.error("Telegram failed to start (check token):", (e as Error).message));
  return bot;
}
