import { readFile } from "node:fs/promises";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run } from "./process";

export interface ConfigIssue {
  severity: "error" | "warning";
  section: string;
  key: string;
  value: string;
  message: string;
}

export function auditBluezSource(source: string): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  let section = "";
  for (const original of source.split("\n")) {
    const line = original.trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[([^\]]+)]$/);
    if (header) { section = header[1]!; continue; }
    const setting = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (!setting) continue;
    const key = setting[1]!.trim();
    const value = setting[2]!.trim();
    const add = (severity: ConfigIssue["severity"], message: string) => issues.push({ severity, section, key, value, message });
    if (section === "General" && ["IdleTimeout", "UserspaceHID"].includes(key)) add("error", "unsupported in BlueZ 5.86");
    if (section === "BR" && ["ReconnectAttempts", "ReconnectIntervals"].includes(key)) add("error", "belongs to policy configuration, not the BR controller section");
    if (section === "BR" && key === "PageScanType" && !/^\d+$/.test(value)) add("error", "must be an integer controller parameter");
    if (section === "BR" && key === "IdleTimeout" && Number(value) < 500) add("error", "BlueZ rejects values below 500");
    if (section === "BR" && key === "LinkSupervisionTimeout" && Number(value) < 8_000) {
      add("warning", "very short custom link supervision timeout; can drop idle links during pairing");
    }
  }
  return issues;
}

export async function auditBluezConfig(path = "/etc/bluetooth/main.conf"): Promise<ConfigIssue[]> {
  return auditBluezSource(await readFile(path, "utf8"));
}

export function sanitizeBluezSource(source: string): string {
  const bad = new Set(auditBluezSource(source).map(issue => `${issue.section}\0${issue.key}`));
  let section = "";
  return source.split("\n").map(original => {
    const line = original.trim();
    const header = line.match(/^\[([^\]]+)]$/);
    if (header) { section = header[1]!; return original; }
    const setting = line.match(/^([^#=]+?)\s*=/);
    if (setting && bad.has(`${section}\0${setting[1]!.trim()}`)) return `# blauwerk disabled: ${original}`;
    return original;
  }).join("\n");
}

export async function fixBluezConfig(path = "/etc/bluetooth/main.conf"): Promise<{ backup: string; issuesFixed: number }> {
  const source = await readFile(path, "utf8");
  const issues = auditBluezSource(source);
  if (!issues.length) return { backup: "", issuesFixed: 0 };
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const backup = `${path}.blauwerk-${stamp}.bak`;
  const temporary = join(tmpdir(), `blauwerk-main-${process.pid}.conf`);
  writeFileSync(temporary, sanitizeBluezSource(source), { mode: 0o600 });
  try {
    await run(["sudo", "cp", "--archive", path, backup], { timeoutMs: 30_000 });
    await run(["sudo", "install", "-m", "0644", temporary, path], { timeoutMs: 30_000 });
    await run(["sudo", "systemctl", "restart", "bluetooth"], { timeoutMs: 30_000 });
  } finally {
    try { unlinkSync(temporary); } catch { /* best effort */ }
  }
  return { backup, issuesFixed: issues.length };
}
