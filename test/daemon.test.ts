import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let runArgv: string[][] = [];
let runResult = { exitCode: 0, stdout: "mock-output", stderr: "", timedOut: false, argv: [] as string[] };

mock.module("../src/process", () => ({
  run: (argv: string[], opts?: any) => {
    runArgv.push(argv);
    return Promise.resolve({ ...runResult, argv });
  },
  commandExists: async () => true,
}));

import { installDaemon, startDaemon, stopDaemon, getDaemonStatus } from "../src/daemon";

describe("daemon", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "blauwerk-daemon-test-"));
    runArgv = [];
    runResult = { exitCode: 0, stdout: "mock-output", stderr: "", timedOut: false, argv: [] };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true });
  });

  test("installDaemon writes systemd user service file and reloads", async () => {
    await installDaemon(300, 30, tempDir);

    const servicePath = join(tempDir, ".config", "systemd", "user", "blauwerk-scanner.service");
    expect(existsSync(servicePath)).toBeTrue();

    const content = readFileSync(servicePath, "utf8");
    expect(content).toContain("Description=Blauwerk Passive Bluetooth Scanner Daemon");
    expect(content).toContain("daemon --run --interval 300 --seconds 30");
    expect(content).toContain("Restart=always");
    expect(content).toContain("After=bluetooth.target");
    expect(content).toContain("WantedBy=default.target");

    expect(runArgv.some(a => a.join(" ") === "systemctl --user daemon-reload")).toBeTrue();
  });

  test("installDaemon respects custom interval and scan seconds", async () => {
    await installDaemon(120, 15, tempDir);

    const servicePath = join(tempDir, ".config", "systemd", "user", "blauwerk-scanner.service");
    const content = readFileSync(servicePath, "utf8");
    expect(content).toContain("--interval 120");
    expect(content).toContain("--seconds 15");
  });

  test("startDaemon enables and starts service", async () => {
    await startDaemon();
    expect(runArgv).toHaveLength(1);
    expect(runArgv[0]).toEqual(["systemctl", "--user", "enable", "--now", "blauwerk-scanner"]);
  });

  test("stopDaemon disables and stops service", async () => {
    await stopDaemon();
    expect(runArgv).toHaveLength(1);
    expect(runArgv[0]).toEqual(["systemctl", "--user", "disable", "--now", "blauwerk-scanner"]);
  });

  test("getDaemonStatus queries systemd service status", async () => {
    runResult = { exitCode: 0, stdout: "Active: active (running)", stderr: "", timedOut: false, argv: [] };

    const status = await getDaemonStatus();
    expect(status).toContain("Active: active (running)");
    expect(runArgv).toHaveLength(1);
    expect(runArgv[0]).toEqual(["systemctl", "--user", "status", "blauwerk-scanner"]);
  });

  test("startDaemon throws on systemctl failure", async () => {
    runResult = { exitCode: 1, stdout: "", stderr: "Failed to enable unit", timedOut: false, argv: [] };
    await expect(startDaemon()).rejects.toThrow("Failed to enable/start daemon service");
  });

  test("stopDaemon throws on systemctl failure", async () => {
    runResult = { exitCode: 1, stdout: "", stderr: "Unit not loaded", timedOut: false, argv: [] };
    await expect(stopDaemon()).rejects.toThrow("Failed to disable/stop daemon service");
  });

  test("installDaemon throws when daemon-reload fails", async () => {
    // We need per-call behavior here, so use a special flag
    const origResult = { ...runResult };
    let callCount = 0;
    // Override the mock inline — mock.module already replaced the module,
    // but we need different results per call for this test.
    // Since our mock reads from `runResult`, we can't easily do per-call.
    // Instead, just test the service file was still written despite the reload failure.
    // The throw comes from the reload step, so the file should exist.
    runResult = { exitCode: 1, stdout: "", stderr: "daemon-reload error", timedOut: false, argv: [] };
    await expect(installDaemon(300, 30, tempDir)).rejects.toThrow("Failed to reload systemd user daemon");
  });
});
