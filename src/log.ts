import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

const stamp = new Date().toISOString().replaceAll(":", "-");
let directory = Bun.env.LOG_DIR ?? join(Bun.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "blauwerk");
try {
  mkdirSync(directory, { recursive: true });
} catch {
  directory = join(tmpdir(), `blauwerk-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
  mkdirSync(directory, { recursive: true });
}
export const logPath = join(directory, `${stamp}.jsonl`);

export function log(event: string, data: Record<string, unknown> = {}): void {
  const record = JSON.stringify({ time: new Date().toISOString(), event, ...data });
  try { appendFileSync(logPath, `${record}\n`, { encoding: "utf8", mode: 0o600 }); } catch { /* logging must not break recovery */ }
  console.error(`[${event}]`, ...Object.entries(data).map(([key, value]) => `${key}=${String(value)}`));
}
