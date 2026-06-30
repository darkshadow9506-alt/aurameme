/* Tiny leveled logger — no dependency, timestamped, colourised. */

const COLORS: Record<string, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  ok: "\x1b[32m",
};
const RESET = "\x1b[0m";

function stamp(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function emit(level: keyof typeof COLORS, scope: string, args: unknown[]) {
  const color = COLORS[level] ?? "";
  // eslint-disable-next-line no-console
  console.log(`${color}${stamp()} [${level.toUpperCase()}] (${scope})${RESET}`, ...args);
}

export function makeLogger(scope: string) {
  return {
    debug: (...a: unknown[]) => emit("debug", scope, a),
    info: (...a: unknown[]) => emit("info", scope, a),
    warn: (...a: unknown[]) => emit("warn", scope, a),
    error: (...a: unknown[]) => emit("error", scope, a),
    ok: (...a: unknown[]) => emit("ok", scope, a),
  };
}

export type Logger = ReturnType<typeof makeLogger>;
