import { config } from "../config.js";

/**
 * Global concurrency limiter for outbound API calls.
 *
 * The Solana program-logs feed is a firehose (several new pump.fun tokens per
 * second). Without a cap, each one fans out into multiple Helius/DexScreener
 * requests at once and instantly blows the free-tier rate limit / the VPN's
 * connection table → every fetch fails. Funnelling all external requests
 * through one limiter keeps us under the cap and the connections healthy.
 */
export function createLimiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

const apiLimit = createLimiter(config.maxConcurrentRequests);

/** Rate/concurrency-limited fetch with a hard timeout so stuck calls free up. */
export function limitedFetch(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  return apiLimit(() => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }));
}
