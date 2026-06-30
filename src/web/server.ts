import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { makeLogger } from "../util/logger.js";
import { engine } from "../engine.js";
import { store } from "../store/store.js";
import { tracker } from "../live/tracker.js";

const log = makeLogger("web");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Lightweight dashboard + JSON API + Server-Sent-Events live feed. */
export function startWeb() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/api/health", (_req, res) =>
    res.json({ ok: true, dryRun: config.dryRun, minScore: config.engine.signalMinScore }),
  );

  app.get("/api/recent", (req, res) => {
    const limit = Math.min(200, Number(req.query.limit) || 60);
    res.json(store.recentAnalyses(limit));
  });

  app.get("/api/signals", (_req, res) => {
    res.json(
      store
        .recentAnalyses(200)
        .filter((a) => a.score >= config.engine.signalMinScore),
    );
  });

  app.get("/api/wallets", (_req, res) => res.json(store.allSmart()));

  app.get("/api/positions", (_req, res) => res.json(tracker.positionsDTO()));

  app.get("/api/token/:mint", async (req, res) => {
    try {
      const existing = store.getAnalysis(req.params.mint);
      if (existing) return res.json(existing);
      const a = await engine.analyzeMint(req.params.mint);
      res.json(a);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // --- SSE live feed ---
  const clients = new Set<express.Response>();
  app.get("/api/stream", (req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
  });

  const broadcast = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(payload);
  };
  engine.on("analysis", (a) => broadcast("analysis", a));
  engine.on("signal", (a) => broadcast("signal", a));
  engine.on("alert", (al) => broadcast("alert", al));

  app.listen(config.web.port, config.web.host, () =>
    log.ok(`dashboard at http://${config.web.host}:${config.web.port}`),
  );
}
