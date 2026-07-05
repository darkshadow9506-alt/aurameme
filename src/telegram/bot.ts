import { Bot, InlineKeyboard } from "grammy";
import { config } from "../config.js";
import { makeLogger } from "../util/logger.js";
import { engine } from "../engine.js";
import { store } from "../store/store.js";
import { tracker } from "../live/tracker.js";
import { activeProfile } from "../signals/profiles.js";
import { formatSignal, formatShort, formatAlert, formatExitPlan, formatUserExit } from "./format.js";
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

  // timeoutSeconds keeps a black-holed connection from hanging silently for
  // minutes — failures surface as loggable errors instead of dead air.
  const bot = new Bot(config.telegram.token, { client: { timeoutSeconds: 20 } });

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
    // conviction/survivor picks ARE the signals now (the old score>=70 filter
    // predates that and silently hid them)
    const list = store
      .recentAnalyses(1500)
      .filter((a) => a.conviction)
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
  // Retries with backoff: a signal is the single most important message this
  // bot sends — a transient network blip must NOT drop it (which is exactly
  // what happened to the first live conviction signal).
  const PUSH_RETRY_DELAYS_MS = [0, 5_000, 15_000, 45_000, 90_000];
  const pushAll = async (text: string, keyboard?: InlineKeyboard) => {
    for (const id of config.telegram.chatIds) {
      let sent = false;
      for (const delay of PUSH_RETRY_DELAYS_MS) {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        try {
          await bot.api.sendMessage(id, text, {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
            reply_markup: keyboard,
          });
          sent = true;
          break;
        } catch (e) {
          log.warn(`push to ${id} failed, will retry:`, (e as Error).message);
        }
      }
      if (!sent)
        log.error(`push to ${id} FAILED after all retries — check /signals for missed ones.`);
    }
  };

  const imInButton = (mint: string) =>
    new InlineKeyboard().text("✅ I'm in — tell me when to sell", `in:${mint}`);

  // Telegram gets ONLY the strict conviction signals (a few a day) with an
  // "I'm in" button — the safest, whale/demand-backed, explosive picks.
  engine.on("signal", (a: Analysis) => void pushAll(formatSignal(a), imInButton(a.mint)));

  // Raw whale ENTRY pings cover unproven fresh launches, so they're OFF by
  // default (PUSH_WHALE_ENTRIES=1 re-enables). The quality Telegram feed is:
  // conviction signals + survivor breakouts + personalized exits.
  engine.on("alert", (al: Alert) => {
    if (al.kind === "ENTRY") {
      if (config.pushWhaleEntries) void pushAll(formatAlert(al), imInButton(al.mint));
    } else if (al.kind === "EXIT" || al.kind === "EXIT_WARNING") {
      void notifyHolders(al);
    }
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
      // USD refs so the slow (DexScreener-poll) watcher can guard exits for
      // tokens that trade off the bonding curve (survivor signals)
      entryPriceUsd: a?.marketFacts?.priceUsd ?? null,
      peakPriceUsd: a?.marketFacts?.priceUsd ?? null,
      entryLiqUsd: a?.marketFacts?.liquidityUsd ?? null,
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
  // Silence watchdog: if Telegram hasn't confirmed within 25s, say so loudly —
  // a black-holed api.telegram.org (VPN exit blocking it) used to look like
  // a healthy boot with a mysteriously deaf bot.
  const silence = setTimeout(
    () =>
      log.error(
        "Telegram: no answer from api.telegram.org after 25s — your VPN exit is " +
          "likely blocking it. The bot can't receive commands until this connects. " +
          "Try another VPN server, then restart.",
      ),
    25_000,
  );
  silence.unref();

  // bot.start() long-polls; if it rejects, keep the process alive and log a
  // diagnosis the user can act on (the engine + web keep running regardless).
  bot
    .start({
      onStart: (i) => {
        clearTimeout(silence);
        log.ok(`Telegram bot @${i.username} online`);
      },
    })
    .catch((e) => {
      const msg = (e as Error)?.message ?? String(e);
      if (msg.includes("409")) {
        log.error(
          "Telegram 409: ANOTHER copy of this bot is running with the same token " +
            "(an old terminal or pm2). Only ONE can poll — close the other one " +
            "(pm2 delete all / taskkill node) and restart.",
        );
      } else if (msg.includes("401")) {
        log.error("Telegram 401: token rejected — re-copy TELEGRAM_BOT_TOKEN from @BotFather.");
      } else {
        log.error("Telegram failed/stopped:", msg);
      }
    });
  return bot;
}
