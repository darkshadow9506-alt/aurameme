import { promises as fs } from "node:fs";
import path from "node:path";
import type { Analysis } from "../types.js";

/**
 * Dead-simple persistence: keep recent analyses + a smart-money table in memory,
 * snapshot to a JSON file periodically. No native deps => runs anywhere.
 */

export interface SmartWallet {
  wallet: string;
  label: string;
  wins: number;
  losses: number;
  /** realized pnl in SOL (best effort, accumulated from observed trades) */
  pnlSol: number;
  lastSeen: number;
}

interface Snapshot {
  analyses: Analysis[];
  smartWallets: SmartWallet[];
}

const DATA_DIR = path.resolve(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "store.json");
const MAX_ANALYSES = 500;

export class Store {
  private analyses = new Map<string, Analysis>();
  private smart = new Map<string, SmartWallet>();
  private dirty = false;

  async init(seedWallets: string[] = []) {
    try {
      const raw = await fs.readFile(FILE, "utf8");
      const snap = JSON.parse(raw) as Snapshot;
      for (const a of snap.analyses ?? []) this.analyses.set(a.mint, a);
      for (const w of snap.smartWallets ?? []) this.smart.set(w.wallet, w);
    } catch {
      /* first run, no file yet */
    }
    for (const w of seedWallets) {
      if (!this.smart.has(w)) {
        this.smart.set(w, {
          wallet: w,
          label: "seed",
          wins: 0,
          losses: 0,
          pnlSol: 0,
          lastSeen: Date.now(),
        });
      }
    }
    // periodic flush
    setInterval(() => void this.flush(), 15_000).unref();
  }

  upsertAnalysis(a: Analysis) {
    this.analyses.set(a.mint, a);
    // trim oldest
    if (this.analyses.size > MAX_ANALYSES) {
      const oldest = [...this.analyses.values()].sort(
        (x, y) => x.scoredAt - y.scoredAt,
      )[0];
      if (oldest) this.analyses.delete(oldest.mint);
    }
    this.dirty = true;
  }

  getAnalysis(mint: string) {
    return this.analyses.get(mint);
  }

  recentAnalyses(limit = 100): Analysis[] {
    return [...this.analyses.values()]
      .sort((a, b) => b.scoredAt - a.scoredAt)
      .slice(0, limit);
  }

  // ---- smart money ----
  isSmart(wallet: string): SmartWallet | undefined {
    return this.smart.get(wallet);
  }

  allSmart(): SmartWallet[] {
    return [...this.smart.values()].sort((a, b) => b.pnlSol - a.pnlSol);
  }

  /** O(1) count, for hot-path cap checks (avoids sorting the whole table). */
  smartCount(): number {
    return this.smart.size;
  }

  addSmart(wallet: string, label = "manual") {
    if (!this.smart.has(wallet)) {
      this.smart.set(wallet, {
        wallet,
        label,
        wins: 0,
        losses: 0,
        pnlSol: 0,
        lastSeen: Date.now(),
      });
      this.dirty = true;
    }
    return this.smart.get(wallet)!;
  }

  recordSmartResult(wallet: string, pnlSol: number) {
    const w = this.smart.get(wallet);
    if (!w) return;
    w.pnlSol += pnlSol;
    if (pnlSol >= 0) w.wins += 1;
    else w.losses += 1;
    w.lastSeen = Date.now();
    this.dirty = true;
  }

  removeSmart(wallet: string) {
    const ok = this.smart.delete(wallet);
    if (ok) this.dirty = true;
    return ok;
  }

  async flush() {
    if (!this.dirty) return;
    this.dirty = false;
    const snap: Snapshot = {
      analyses: this.recentAnalyses(MAX_ANALYSES),
      smartWallets: this.allSmart(),
    };
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(snap, null, 2), "utf8");
  }
}

export const store = new Store();
