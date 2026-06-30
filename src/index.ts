import { config } from "./config.js";
import { makeLogger } from "./util/logger.js";
import { setupProxy } from "./net/proxy.js";
import { store } from "./store/store.js";
import { engine } from "./engine.js";
import { startTelegram } from "./telegram/bot.js";
import { startWeb } from "./web/server.js";

const log = makeLogger("main");

// Resilience: a long-running live bot must survive stray async errors (network
// blips, a websocket hiccup, an unawaited promise) instead of dying.
process.on("unhandledRejection", (reason) =>
  log.error("unhandledRejection:", reason instanceof Error ? reason.message : reason),
);
process.on("uncaughtException", (err) => log.error("uncaughtException:", err.message));

async function main() {
  log.info("AuraMeme starting…");
  log.info(
    `config: minScore=${config.engine.signalMinScore} minLiq=$${config.engine.minLiquidityUsd} dryRun=${config.dryRun}`,
  );

  // route outbound traffic through a proxy first (for running inside Iran)
  await setupProxy();

  await store.init(config.engine.smartMoneyWallets);

  // start the analysis engine (always)
  engine.start();

  // web dashboard (always)
  startWeb();

  // telegram (only if configured)
  startTelegram();

  log.ok("AuraMeme is live. Open the dashboard or talk to your Telegram bot.");

  const shutdown = async (sig: string) => {
    log.warn(`${sig} received — flushing & exiting`);
    await store.flush();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  log.error("fatal:", e);
  process.exit(1);
});
