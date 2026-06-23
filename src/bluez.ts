import { join } from "node:path";
import { commandExists, run } from "./process";
import type { Agent, DeviceState, RunResult, ScanMode } from "./types";

const MAC = /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/;

export function normalizeMac(value: string): string {
  const mac = value.toUpperCase();
  if (!MAC.test(mac)) throw new Error(`Invalid Bluetooth MAC: ${value}`);
  return mac;
}

export function parseDeviceInfo(raw: string, fallbackMac = "00:00:00:00:00:00"): DeviceState {
  const value = (key: string) => raw.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, "mi"))?.[1]?.trim();
  const yes = (key: string) => value(key)?.toLowerCase() === "yes";
  const headerMac = raw.match(/^Device\s+([0-9A-F:]{17})/mi)?.[1];
  const bonded = value("Bonded");
  const servicesResolved = value("ServicesResolved");
  const rssiValue = value("RSSI");
  const rssi = rssiValue?.match(/\((-?\d+)\)\s*$/)?.[1] ?? rssiValue?.match(/^-?\d+$/)?.[0];
  return {
    mac: headerMac ?? fallbackMac, available: !/not available/i.test(raw),
    name: value("Name"), alias: value("Alias"), paired: yes("Paired"),
    bonded: bonded === undefined ? undefined : bonded.toLowerCase() === "yes",
    trusted: yes("Trusted"), blocked: yes("Blocked"), connected: yes("Connected"),
    servicesResolved: servicesResolved === undefined ? undefined : servicesResolved.toLowerCase() === "yes",
    rssi: rssi === undefined ? undefined : Number(rssi),
    uuids: [...raw.matchAll(/^\s*UUID:\s*(.+)$/gmi)].map(match => match[1]!.trim()), raw,
  };
}

export class Bluez {
  constructor(private readonly dryRun = false, private readonly noSudo = false) {}

  async assertReady(): Promise<void> {
    if (!await commandExists("bluetoothctl")) throw new Error("bluetoothctl is missing (install BlueZ)");
  }

  private async bt(args: string[], timeoutMs = 30_000, agent?: Agent) {
    const argv = ["bluetoothctl", "--timeout", String(Math.max(1, Math.ceil(timeoutMs / 1_000))), ...(agent ? ["--agent", agent] : []), ...args];
    return run(argv, { timeoutMs: timeoutMs + 2_000, allowFailure: true });
  }

  private async privileged(args: string[], timeoutMs = 15_000): Promise<void> {
    if (this.dryRun) return;
    const argv = typeof process.getuid === "function" && process.getuid() === 0
      ? args : this.noSudo ? [] : ["sudo", ...args];
    if (!argv.length) throw new Error(`Privileged action skipped by --no-sudo: ${args.join(" ")}`);
    await run(argv, { timeoutMs });
  }

  async info(mac: string): Promise<DeviceState> {
    mac = normalizeMac(mac);
    const result = await this.bt(["info", mac], 8_000);
    return parseDeviceInfo(`${result.stdout}\n${result.stderr}`, mac);
  }

  async devices(): Promise<DeviceState[]> {
    const result = await this.bt(["devices"], 8_000);
    const rows = [...result.stdout.matchAll(/^Device\s+([0-9A-F:]{17})\s+(.+)$/gmi)];
    return rows.map(row => ({ ...parseDeviceInfo("", row[1]!), name: row[2]!.trim() }));
  }

  async scan(mode: ScanMode, seconds: number): Promise<DeviceState[]> {
    if (!(["bredr", "le", "on"] as string[]).includes(mode)) throw new Error(`Invalid scan mode: ${mode}`);
    if (this.dryRun) return this.devices();
    await this.stopScan();
    const duration = Math.max(1, seconds);
    const session = Bun.spawn(["bluetoothctl"], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe", env: Bun.env,
    });
    const output = Promise.all([
      new Response(session.stdout).text(),
      new Response(session.stderr).text(),
    ]);
    try {
      const stdin = session.stdin;
      if (!stdin) throw new Error("Could not open bluetoothctl scan session");
      stdin.write(`scan ${mode}\n`);
      await Bun.sleep(duration * 1_000);
      stdin.write("scan off\nquit\n");
      stdin.end();
      const exit = await Promise.race([
        session.exited,
        Bun.sleep(10_000).then(() => 124),
      ]);
      if (exit === 124) session.kill("SIGKILL");
      const [stdout, stderr] = await output;
      if (!/Discovery started|SetDiscoveryFilter success|Changing power on succeeded/i.test(`${stdout}\n${stderr}`)) {
        throw new Error(`BlueZ did not confirm discovery start: ${(stderr || stdout).trim()}`);
      }
    } finally {
      if (session.exitCode === null) session.kill("SIGKILL");
      await this.stopScan();
    }
    return this.devices();
  }

  async stopScan(): Promise<void> { if (!this.dryRun) await this.bt(["scan", "off"], 8_000); }

  async prepare(): Promise<void> {
    if (this.dryRun) return;
    for (const args of [["power", "on"], ["pairable", "on"], ["scan", "off"]]) await this.bt(args);
  }

  async pair(mac: string, agent: Agent, timeoutMs: number): Promise<RunResult> {
    if (this.dryRun) return { argv: [], exitCode: 0, stdout: "dry-run", stderr: "", timedOut: false };
    const result = await this.bt(["pair", normalizeMac(mac)], timeoutMs, agent);
    if (result.exitCode !== 0) throw new Error(`${result.timedOut ? "Pairing timed out\n" : ""}${result.stderr || result.stdout || "Pairing failed"}`);
    return result;
  }

  async cancelPairing(mac: string): Promise<void> {
    if (!this.dryRun) await this.bt(["cancel-pairing", normalizeMac(mac)], 8_000);
  }

  async trust(mac: string): Promise<void> {
    if (this.dryRun) return;
    const result = await this.bt(["trust", normalizeMac(mac)]);
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || "Trust failed");
  }
  async connect(mac: string, profile?: string, timeoutMs = 25_000): Promise<void> {
    if (this.dryRun) return;
    const result = await this.bt(["connect", normalizeMac(mac), ...(profile ? [profile] : [])], timeoutMs);
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || "Connection failed");
  }
  async disconnect(mac: string): Promise<void> { if (!this.dryRun) await this.bt(["disconnect", normalizeMac(mac)]); }
  async remove(mac: string): Promise<void> { if (!this.dryRun) await this.bt(["remove", normalizeMac(mac)]); }

  async restartBluetooth(): Promise<void> {
    await this.privileged(["systemctl", "restart", "bluetooth"]);
    await Bun.sleep(2_000);
  }

  async restartAudio(): Promise<void> {
    if (!await commandExists("systemctl") || this.dryRun) return;
    for (const unit of ["pipewire", "pipewire-pulse", "wireplumber"])
      await run(["systemctl", "--user", "try-restart", unit], { allowFailure: true, timeoutMs: 12_000 });
  }

  async restartWireplumber(): Promise<void> {
    if (!await commandExists("systemctl") || this.dryRun) return;
    await run(["systemctl", "--user", "restart", "wireplumber"], { timeoutMs: 12_000 });
    await Bun.sleep(2_000);
  }

  async powercycle(): Promise<void> {
    try {
      const off = await this.bt(["power", "off"], 8_000);
      if (off.exitCode !== 0) throw new Error(off.stderr || off.stdout || "controller power off failed");
      await Bun.sleep(1_000);
    } finally {
      await this.bt(["power", "on"], 8_000).catch(() => {});
    }
    await Bun.sleep(2_000);
  }

  async adapterMac(): Promise<string> {
    const result = await this.bt(["list"]);
    const mac = result.stdout.match(/^Controller\s+([0-9A-F:]{17})/mi)?.[1];
    if (!mac) throw new Error("No Bluetooth controller found");
    return normalizeMac(mac);
  }

  async purge(mac: string): Promise<void> {
    mac = normalizeMac(mac);
    const adapter = await this.adapterMac();
    const base = join("/var/lib/bluetooth", adapter);
    const candidates = [join(base, mac), join(base, "cache", mac)];
    // Exact validated paths only. Never interpolate arbitrary user input into rm.
    await this.privileged(["systemctl", "stop", "bluetooth"]);
    try {
      for (const path of candidates) await this.privileged(["rm", "-rf", "--", path]);
    } finally {
      await this.privileged(["systemctl", "start", "bluetooth"]);
    }
    await Bun.sleep(2_000);
  }

  async diagnostics(): Promise<Record<string, string>> {
    const output: Record<string, string> = {};
    for (const [name, argv] of Object.entries({ controllers: ["bluetoothctl", "list"], controller: ["bluetoothctl", "show"], rfkill: ["rfkill", "list", "bluetooth"], audio: ["wpctl", "status"] })) {
      if (await commandExists(argv[0]!)) {
        const result = await run(argv, { allowFailure: true, timeoutMs: 10_000 });
        output[name] = `${result.stdout}${result.stderr}`.trim();
      }
    }
    return output;
  }
}
