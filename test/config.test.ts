import { describe, expect, test, mock, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let runMock = (...args: any[]): Promise<any> => Promise.resolve({ exitCode: 0, stdout: "", stderr: "", timedOut: false });

mock.module("../src/process", () => ({
  run: (...args: any[]) => runMock(...args),
}));

import { auditBluezConfig, auditBluezSource, sanitizeBluezSource, fixBluezConfig } from "../src/config";

describe("BlueZ configuration audit", () => {
  beforeEach(() => {
    runMock = (...args: any[]): Promise<any> => Promise.resolve({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
  });

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

  test("returns empty issues for empty config files", () => {
    const issues = auditBluezSource("");
    expect(issues).toHaveLength(0);
  });

  test("returns empty issues for config files with only comments", () => {
    const issues = auditBluezSource("# This is a comment\n# Another setting=123\n");
    expect(issues).toHaveLength(0);
  });

  test("ignores malformed lines or non-key-value settings", () => {
    const issues = auditBluezSource("[General]\nMalformedLineWithoutEquals\n=NoKey\nKeyWithoutVal=\n");
    expect(issues).toHaveLength(0);
  });

  test("reports error for General UserspaceHID", () => {
    const issues = auditBluezSource("[General]\nUserspaceHID=true\n");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.key).toBe("UserspaceHID");
    expect(issues[0]?.severity).toBe("error");
  });

  test("reports error for General IdleTimeout", () => {
    const issues = auditBluezSource("[General]\nIdleTimeout=123\n");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.key).toBe("IdleTimeout");
    expect(issues[0]?.severity).toBe("error");
  });

  test("reports error for BR ReconnectAttempts", () => {
    const issues = auditBluezSource("[BR]\nReconnectAttempts=5\n");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.key).toBe("ReconnectAttempts");
    expect(issues[0]?.severity).toBe("error");
  });

  test("reports error for BR ReconnectIntervals", () => {
    const issues = auditBluezSource("[BR]\nReconnectIntervals=10\n");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.key).toBe("ReconnectIntervals");
    expect(issues[0]?.severity).toBe("error");
  });

  test("reports error for BR PageScanType if value is not integer", () => {
    const issues = auditBluezSource("[BR]\nPageScanType=interleaved\n");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.key).toBe("PageScanType");
    expect(issues[0]?.severity).toBe("error");
  });

  test("reports error for BR IdleTimeout < 500", () => {
    const issues = auditBluezSource("[BR]\nIdleTimeout=499\n");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.key).toBe("IdleTimeout");
    expect(issues[0]?.severity).toBe("error");
  });

  test("reports error for non-integer BR IdleTimeout", () => {
    const issues = auditBluezSource("[BR]\nIdleTimeout=fast\n");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.key).toBe("IdleTimeout");
    expect(issues[0]?.severity).toBe("error");
  });

  test("does not report error for BR IdleTimeout >= 500", () => {
    const issues = auditBluezSource("[BR]\nIdleTimeout=500\nIdleTimeout=600\n");
    expect(issues).toHaveLength(0);
  });

  test("reports warning for BR LinkSupervisionTimeout < 8000", () => {
    const issues = auditBluezSource("[BR]\nLinkSupervisionTimeout=7999\n");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.key).toBe("LinkSupervisionTimeout");
    expect(issues[0]?.severity).toBe("warning");
  });

  test("reports error for non-integer BR LinkSupervisionTimeout", () => {
    const issues = auditBluezSource("[BR]\nLinkSupervisionTimeout=short\n");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.key).toBe("LinkSupervisionTimeout");
    expect(issues[0]?.severity).toBe("error");
  });

  test("does not report warning for BR LinkSupervisionTimeout >= 8000", () => {
    const issues = auditBluezSource("[BR]\nLinkSupervisionTimeout=8000\nLinkSupervisionTimeout=10000\n");
    expect(issues).toHaveLength(0);
  });

  test("fixBluezConfig returns early with no action if no issues are found", async () => {
    const directory = mkdtempSync(join(tmpdir(), "blauwerk-config-"));
    const path = join(directory, "main.conf");
    writeFileSync(path, "[General]\nFastConnectable=true\n");
    let runCalled = false;
    runMock = async () => {
      runCalled = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    try {
      const result = await fixBluezConfig(path);
      expect(result.backup).toBe("");
      expect(result.issuesFixed).toBe(0);
      expect(runCalled).toBeFalse();
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  test("fixBluezConfig executes backup, install, and service restart if issues exist", async () => {
    const directory = mkdtempSync(join(tmpdir(), "blauwerk-config-"));
    const path = join(directory, "main.conf");
    writeFileSync(path, "[General]\nIdleTimeout=0\n");
    let runs: string[][] = [];
    runMock = async (argv) => {
      runs.push(argv);
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    try {
      const result = await fixBluezConfig(path);
      expect(result.backup).toContain("main.conf.blauwerk-");
      expect(result.backup).toContain(".bak");
      expect(result.issuesFixed).toBe(1);
      expect(runs.length).toBe(3);
      expect(runs[0]).toContain("cp");
      expect(runs[1]).toContain("install");
      expect(runs[2]).toEqual(["sudo", "systemctl", "restart", "bluetooth"]);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});
