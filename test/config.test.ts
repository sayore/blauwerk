import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditBluezConfig, auditBluezSource, sanitizeBluezSource } from "../src/config";

describe("BlueZ configuration audit", () => {
  test("reports unsafe and unsupported settings", async () => {
    const directory = mkdtempSync(join(tmpdir(), "blauwerk-config-"));
    const path = join(directory, "main.conf");
    writeFileSync(path, "[General]\nIdleTimeout=0\n[BR]\nPageScanType=interleaved\nLinkSupervisionTimeout=1600\n");
    try {
      const issues = await auditBluezConfig(path);
      expect(issues.some(issue => issue.key === "PageScanType")).toBeTrue();
      expect(issues.some(issue => issue.key === "LinkSupervisionTimeout")).toBeTrue();
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  test("comments only audited settings", () => {
    const source = "[General]\nFastConnectable=true\nIdleTimeout=0\n[BR]\nLinkSupervisionTimeout=1600\n";
    const sanitized = sanitizeBluezSource(source);
    expect(sanitized).toContain("FastConnectable=true");
    expect(sanitized).toContain("# blauwerk disabled: IdleTimeout=0");
    expect(auditBluezSource(sanitized)).toHaveLength(0);
  });
});
