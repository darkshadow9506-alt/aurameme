import { config } from "../config.js";
import { makeLogger } from "../util/logger.js";

const log = makeLogger("proxy");

let wsAgent: unknown = undefined;

/**
 * Route all outbound traffic through a proxy so the bot can run on your own
 * machine inside Iran (the data APIs sanction-block Iranian IPs directly).
 *
 *   PROXY_URL=http://127.0.0.1:8080      # HTTP/HTTPS proxy (e.g. V2Ray http in)
 *   PROXY_URL=socks5://127.0.0.1:1080    # SOCKS5 (e.g. Shadowsocks / V2Ray)
 *
 * - `fetch` (DexScreener / Solana RPC / Helius / Birdeye) is routed via an
 *   undici global dispatcher.
 * - the PumpPortal websocket is routed via a proxy agent (see getWsAgent()).
 *
 * Whole thing is best-effort: a bad/unreachable proxy logs and the bot still
 * boots (you'll just see 403/timeout until the proxy works).
 */
export async function setupProxy(): Promise<void> {
  const url = config.proxyUrl;
  if (!url) return;
  const isSocks = /^socks/i.test(url);
  log.info(`routing outbound traffic through proxy (${isSocks ? "socks" : "http"})`);

  // ---- fetch (undici global dispatcher) ----
  try {
    const { setGlobalDispatcher, ProxyAgent } = await import("undici");
    if (isSocks) {
      const { socksDispatcher } = await import("fetch-socks");
      const u = new URL(url);
      const type = u.protocol.startsWith("socks4") ? 4 : 5;
      setGlobalDispatcher(
        socksDispatcher({
          type: type as 4 | 5,
          host: u.hostname,
          port: Number(u.port) || 1080,
          ...(u.username ? { userId: decodeURIComponent(u.username) } : {}),
          ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
        }),
      );
    } else {
      setGlobalDispatcher(new ProxyAgent(url));
    }
    log.ok("fetch() now goes through the proxy");
  } catch (e) {
    log.error("failed to set up fetch proxy:", (e as Error).message);
  }

  // ---- websocket agent ----
  try {
    if (isSocks) {
      const { SocksProxyAgent } = await import("socks-proxy-agent");
      wsAgent = new SocksProxyAgent(url);
    } else {
      const { HttpsProxyAgent } = await import("https-proxy-agent");
      wsAgent = new HttpsProxyAgent(url);
    }
    log.ok("websocket now goes through the proxy");
  } catch (e) {
    log.error("failed to set up websocket proxy:", (e as Error).message);
  }
}

/** Agent for the `ws` client, or undefined when no proxy is configured. */
export function getWsAgent(): unknown {
  return wsAgent;
}
