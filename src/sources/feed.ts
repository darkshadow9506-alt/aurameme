import type { EventEmitter } from "node:events";
import { config } from "../config.js";
import { makeLogger } from "../util/logger.js";
import { PumpPortal } from "./pumpportal.js";
import { SolanaLogsFeed } from "./solanaLogs.js";

const log = makeLogger("feed");

/**
 * Common realtime-feed interface. Both the PumpPortal websocket and the direct
 * Solana program-logs feed implement it, so the engine doesn't care which one
 * is active.
 *
 * Emits: "newToken" | "trade" | "walletTrade"  (all PumpEvent)
 */
export interface TokenFeed extends EventEmitter {
  start(): void;
  watchToken(mint: string): void;
  unwatchToken(mint: string): void;
  watchWallet(wallet: string): void;
  unwatchWallet(wallet: string): void;
}

/**
 * Pick the feed from FEED_SOURCE:
 *   "pumpportal" (default) — pump.fun's own websocket
 *   "solana"               — decode pump.fun program logs over the Solana RPC
 *                            websocket (use when pumpportal is blocked but your
 *                            RPC, ideally Helius, is reachable)
 */
export function createFeed(): TokenFeed {
  if (config.feedSource === "solana") {
    log.info("feed source: solana program logs (direct RPC)");
    return new SolanaLogsFeed();
  }
  log.info("feed source: pumpportal");
  return new PumpPortal();
}
