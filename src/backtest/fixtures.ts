import { promises as fs } from "node:fs";
import type { BtToken } from "./simulate.js";

/**
 * Synthetic-but-realistic memecoin trajectories so the backtest runs out of the
 * box. Real memecoins cluster into a few archetypes: a few moon, more pump-then-
 * rug, and most fade to zero. A seeded RNG keeps runs reproducible.
 *
 * To backtest on REAL history instead, export your own dataset as JSON matching
 * the BtToken[] shape and run:  npm run backtest -- path/to/data.json
 */

// deterministic RNG (mulberry32)
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Archetype = "moon" | "moonThenRug" | "pumpDump" | "instantRug" | "chop" | "slowBleed";

function walk(rand: () => number, start: number, steps: number, driftPct: number, volPct: number) {
  const series = [{ mcap: start }];
  let v = start;
  for (let i = 1; i < steps; i++) {
    const shock = (rand() - 0.5) * 2 * volPct;
    v = Math.max(1, v * (1 + driftPct + shock));
    series.push({ mcap: v });
  }
  return series;
}

function makeToken(i: number, rand: () => number): BtToken {
  const r = rand();
  let archetype: Archetype;
  if (r < 0.08) archetype = "moon";
  else if (r < 0.22) archetype = "moonThenRug";
  else if (r < 0.42) archetype = "pumpDump";
  else if (r < 0.6) archetype = "instantRug";
  else if (r < 0.8) archetype = "chop";
  else archetype = "slowBleed";

  const start = 40 + rand() * 60; // starting market cap (SOL)
  const steps = 60;
  let series: { mcap: number }[];
  const events: BtToken["events"] = [];

  switch (archetype) {
    case "moon": {
      const peak = 5 + rand() * 12; // 5x–17x
      const up = walk(rand, start, 35, Math.log(peak) / 35, 0.06);
      const down = walk(rand, up[up.length - 1].mcap, 25, -0.01, 0.05);
      series = [...up, ...down];
      break;
    }
    case "moonThenRug": {
      const peak = 3 + rand() * 6;
      series = walk(rand, start, 30, Math.log(peak) / 30, 0.06);
      events.push({ at: series.length - 2, type: "smartSell" });
      events.push({ at: series.length - 1, type: "rug" });
      break;
    }
    case "pumpDump": {
      const peak = 1.6 + rand() * 1.8;
      const up = walk(rand, start, 12, Math.log(peak) / 12, 0.07);
      const down = walk(rand, up[up.length - 1].mcap, 20, -0.08, 0.06);
      series = [...up, ...down];
      if (rand() < 0.5) events.push({ at: 12, type: "smartSell" });
      break;
    }
    case "instantRug": {
      const up = walk(rand, start, 5, 0.06, 0.05);
      series = [...up, { mcap: up[up.length - 1].mcap }];
      events.push({ at: series.length - 1, type: "rug" });
      break;
    }
    case "chop":
      series = walk(rand, start, steps, 0, 0.05);
      break;
    case "slowBleed":
    default:
      series = walk(rand, start, steps, -0.03, 0.04);
      break;
  }

  // most launches that survive a bit attract a smart buy early
  if (archetype === "moon" || archetype === "moonThenRug") {
    events.push({ at: 1, type: "smartBuy" });
  }

  return {
    mint: `SIM${i.toString().padStart(4, "0")}`,
    name: `${archetype}-${i}`,
    verdict: archetype === "instantRug" ? "RISKY" : "SIGNAL",
    series,
    events,
    entryIndex: 0,
  };
}

export function generateDataset(count = 250, seed = 42): BtToken[] {
  const rand = rng(seed);
  return Array.from({ length: count }, (_, i) => makeToken(i, rand));
}

export async function loadDataset(path: string): Promise<BtToken[]> {
  const raw = await fs.readFile(path, "utf8");
  const json = JSON.parse(raw);
  const tokens: BtToken[] = Array.isArray(json) ? json : json.tokens;
  if (!Array.isArray(tokens)) throw new Error("dataset must be a BtToken[] or { tokens: BtToken[] }");
  return tokens;
}
