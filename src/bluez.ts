import { join } from "node:path";
import { commandExists, run, type ProcessControl } from "./process";
import type { Agent, BluetoothHostState, DeviceState, RunResult, ScanMode } from "./types";
import { log } from "./log";

const MAC = /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/;

export function normalizeMac(value: string): string {
  const mac = value.toUpperCase();
  if (!MAC.test(mac)) throw new Error(`Invalid Bluetooth MAC: ${value}`);
  return mac;
}

export function parseDeviceInfo(raw: string, fallbackMac = "00:00:00:00:00:00"): DeviceState {
  const value = (key: string) => raw.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, "mi"))?.[1]?.trim();
  const yes = (key: string) => value(key)?.toLowerCase() === "yes";
  const header = raw.match(/^Device\s+([0-9A-F:]{17})(?:\s+\(([^)]+)\))?/mi);
  const headerMac = header?.[1];
  const bonded = value("Bonded");
  const servicesResolved = value("ServicesResolved");
  const rssiValue = value("RSSI");
  const rssi = rssiValue?.match(/\((-?\d+)\)\s*$/)?.[1] ?? rssiValue?.match(/^-?\d+$/)?.[0];
  const batteryValue = value("Battery Percentage");
  const battery = batteryValue?.match(/\((\d+)\)\s*$/)?.[1] ?? batteryValue?.match(/^\d+$/)?.[0] ?? batteryValue?.match(/0x[0-9a-fA-F]+\s*\((\d+)\)/)?.[1];
  return {
    mac: headerMac ?? fallbackMac, available: !/not available/i.test(raw), addressType: header?.[2],
    name: value("Name"), alias: value("Alias"), icon: value("Icon"), class: value("Class"),
    legacyPairing: value("LegacyPairing") === undefined ? undefined : yes("LegacyPairing"), paired: yes("Paired"),
    bonded: bonded === undefined ? undefined : bonded.toLowerCase() === "yes",
    trusted: yes("Trusted"), blocked: yes("Blocked"), connected: yes("Connected"),
    servicesResolved: servicesResolved === undefined ? undefined : servicesResolved.toLowerCase() === "yes",
    rssi: rssi === undefined ? undefined : Number(rssi),
    battery: battery === undefined ? undefined : Number(battery),
    uuids: [...raw.matchAll(/^\s*UUID:\s*(.+)$/gmi)].map(match => match[1]!.trim()), raw,
  };
}

export interface DiscoveryEvent {
  mac: string;
  name?: string;
  rssi?: number;
  class?: string;
  icon?: string;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function defaultEnv(): Record<string, string> {
  const env = Object.fromEntries(Object.entries(Bun.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  if (env.DBUS_SESSION_BUS_ADDRESS === undefined && typeof process.getuid === "function") {
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=/run/user/${process.getuid()}/bus`;
  }
  return env;
}

export function cleanBluetoothctlOutput(value: string): string {
  return stripAnsi(value)
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map(line => line.trim())
    .map(line => line.replace(/^\[[^\]]+\][>#]\s*/, "").trim())
    .filter(Boolean)
    .filter(line => !/^\[[^\]]+\][>#]?\s*$/.test(line))
    .filter(line => !/^SupportedUUIDs:/i.test(line))
    .filter(line => !/^Agent registered$/i.test(line))
    .join("\n");
}

export function connectOutputShowsProgress(value: string): boolean {
  return /org\.bluez\.Error\.InProgress|br-connection-busy|Operation already in progress/i.test(value);
}

export function connectOutputShowsConnected(value: string): boolean {
  return /Connection successful|Connected:\s*yes|ServicesResolved:\s*yes/i.test(value);
}

export function connectOutputShowsCommandSuccess(value: string): boolean {
  return /Connection successful/i.test(value);
}

function summarizeBluetoothctlFailure(value: string, fallback: string): string {
  const clean = cleanBluetoothctlOutput(value);
  const lines = clean.split(/\n+/).filter(Boolean);
  const failure = [...lines].reverse().find(line => /Failed to|org\.bluez\.Error|not available|Authentication|timed out/i.test(line));
  return (failure ?? lines.slice(-4).join("\n") ?? fallback).slice(0, 1_000) || fallback;
}

export function parseControllerState(raw: string): Pick<BluetoothHostState, "controllerAvailable" | "controllerMac" | "powered" | "powerState" | "discovering" | "powerTransitionStuck"> {
  const value = (key: string) => raw.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, "mi"))?.[1]?.trim();
  const controllerMac = raw.match(/^Controller\s+([0-9A-F:]{17})/mi)?.[1];
  const powerState = value("PowerState");
  return {
    controllerAvailable: Boolean(controllerMac) && !/No default controller available/i.test(raw),
    controllerMac,
    powered: value("Powered")?.toLowerCase() === "yes",
    powerState,
    discovering: value("Discovering")?.toLowerCase() === "yes",
    powerTransitionStuck: powerState === undefined ? undefined : /-(?:enabling|disabling)$/i.test(powerState),
  };
}

export function parseDiscoveryLine(line: string): DiscoveryEvent | undefined {
  const clean = stripAnsi(line).replace(/\r/g, "").trim();
  const added = clean.match(/\[(?:NEW|CHG)\]\s+Device\s+([0-9A-F:]{17})(?:\s+(.+?))?\s*$/i);
  if (!added) return undefined;
  const mac = normalizeMac(added[1]!);
  const detail = added[2]?.trim();
  if (!detail) return { mac };

  const nameMatch = detail.match(/^(?:Name|Alias):\s*(.+)$/i);
  if (nameMatch) {
    return { mac, name: nameMatch[1]!.trim() };
  }

  const rssiMatch = detail.match(/^RSSI:\s*(?:0x[0-9a-fA-F]+\s*\((-?\d+)\)|(-?\d+))$/i);
  if (rssiMatch) {
    const val = rssiMatch[1] ?? rssiMatch[2];
    if (val !== undefined) {
      return { mac, rssi: Number(val) };
    }
  }

  const classMatch = detail.match(/^Class:\s*((?:0x[0-9A-Fa-f]+|\d+)(?:\s+\(\d+\))?)$/i);
  if (classMatch) {
    return { mac, class: classMatch[1]!.trim() };
  }

  const iconMatch = detail.match(/^Icon:\s*(.+)$/i);
  if (iconMatch) {
    return { mac, icon: iconMatch[1]!.trim() };
  }

  if (/^[A-Za-z]+(?:\.[A-Za-z]+)*:\s*/.test(detail)) {
    return { mac };
  }

  return { mac, name: detail };
}

async function consumeLines(stream: ReadableStream<Uint8Array>, onLine?: (line: string) => void): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let pending = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    output += text;
    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) onLine?.(line);
  }
  const tail = decoder.decode();
  output += tail;
  pending += tail;
  if (pending) onLine?.(pending);
  return output;
}

export class Bluez {
  private selectedAdapter?: string;
  constructor(private readonly dryRun = false, private readonly noSudo = false) {}

  async assertReady(): Promise<void> {
    if (!await commandExists("bluetoothctl")) throw new Error("bluetoothctl is missing (install BlueZ)");
  }

  private async bt(
    args: string[],
    timeoutMs = 30_000,
    agent?: Agent,
    skipSelect = false,
    interactive = false,
    onStdout?: (text: string, writeStdin: (chunk: string) => void, control?: ProcessControl) => void
  ) {
    if (!skipSelect && !this.selectedAdapter && args[0] !== "list" && !(args[0] === "show" && args.length > 1)) {
      await this.resolveAdapter().catch(() => {});
    }

    if (!skipSelect && this.selectedAdapter && args[0] !== "list" && !(args[0] === "show" && args.length > 1)) {
      const commandStr = args.map(a => a.includes(" ") ? `"${a}"` : a).join(" ");
      
      let input = interactive ? `select ${this.selectedAdapter}\n${commandStr}\n` : `select ${this.selectedAdapter}\n${commandStr}\nquit\n`;
      let keepStdinOpen = false;
      let wrappedOnStdout = onStdout;
      let cleanupOnExit: (() => void) | undefined;
      
      const isConnect = args[0] === "connect";
      const isProfileConnect = isConnect && args.length > 2;
      const isPair = args[0] === "pair";
      
      if (!interactive && (isConnect || isPair)) {
        input = `select ${this.selectedAdapter}\n${commandStr}\n`;
        keepStdinOpen = true;
        let accumulated = "";
        let quitWritten = false;
        let pairSettleScheduled = false;
        const timers: ReturnType<typeof setTimeout>[] = [];
        const clearTimers = () => {
          while (timers.length) {
            const timer = timers.pop();
            if (timer) clearTimeout(timer);
          }
        };
        const writeSafe = (writeStdin: (chunk: string) => void, chunk: string) => {
          try { writeStdin(chunk); } catch {}
        };
        const writeQuit = (writeStdin: (chunk: string) => void) => {
          if (quitWritten) return;
          quitWritten = true;
          clearTimers();
          writeSafe(writeStdin, "quit\n");
        };
        const schedulePairSettle = (writeStdin: (chunk: string) => void) => {
          if (pairSettleScheduled) return;
          pairSettleScheduled = true;
          const mac = args[1];
          const probe = () => {
            if (!quitWritten && mac) writeSafe(writeStdin, `info ${mac}\n`);
          };
          for (const delay of [750, 2_000, 4_000, 7_000]) {
            timers.push(setTimeout(probe, delay));
          }
          timers.push(setTimeout(() => writeQuit(writeStdin), 9_000));
        };
        cleanupOnExit = clearTimers;
        wrappedOnStdout = (text, writeStdin, control) => {
          accumulated += text;
          if (onStdout) {
            try { onStdout(text, writeStdin, control); } catch {}
          }
          if (quitWritten) return;

          if (isConnect) {
            if (/Attempting to connect/i.test(accumulated) && !pairSettleScheduled) {
              pairSettleScheduled = true;
              const mac = args[1];
              const probe = () => {
                if (!quitWritten && mac) writeSafe(writeStdin, `info ${mac}\n`);
              };
              for (const delay of [2_000, 5_000, 9_000]) {
                timers.push(setTimeout(probe, delay));
              }
              timers.push(setTimeout(() => writeQuit(writeStdin), 12_000));
            }
            const hasSuccess = connectOutputShowsCommandSuccess(accumulated) || (!isProfileConnect && connectOutputShowsConnected(accumulated));
            const hasFailure = /Failed to connect|Connection failed|ProfileUnavailable|org\.bluez\.Error/i.test(accumulated);
            if (hasSuccess) {
              writeQuit(writeStdin);
              control?.endStdin();
              timers.push(setTimeout(() => control?.terminate(0), 750));
            } else if (hasFailure) {
              writeQuit(writeStdin);
            }
            return;
          }

          if (/Failed to pair|AuthenticationFailed|org\.bluez\.Error/i.test(accumulated)) {
            writeQuit(writeStdin);
            return;
          }

          if (/Pairing successful/i.test(accumulated)) {
            schedulePairSettle(writeStdin);
            if (/Bonded:\s*yes|ServicesResolved:\s*yes/i.test(accumulated)) {
              timers.push(setTimeout(() => writeQuit(writeStdin), 1_000));
            }
          }
        };
      }
      
      const argv = ["bluetoothctl", "--timeout", String(Math.max(1, Math.ceil(timeoutMs / 1_000))), ...(agent ? ["--agent", agent] : [])];
      const result = await run(argv, { timeoutMs: timeoutMs + 2_000, allowFailure: true, input, interactive, keepStdinOpen, onStdout: wrappedOnStdout });
      cleanupOnExit?.();
      if (result.exitCode === 0) {
        const combined = `${result.stdout}\n${result.stderr}`;
        if (
          /Failed to/i.test(combined) ||
          /not available/i.test(combined) ||
          /error:/i.test(combined) ||
          /AuthenticationFailed/i.test(combined) ||
          /Failed to connect/i.test(combined) ||
          /Failed to pair/i.test(combined)
        ) {
          result.exitCode = 1;
        }
      }
      return result;
    }

    const argv = ["bluetoothctl", "--timeout", String(Math.max(1, Math.ceil(timeoutMs / 1_000))), ...(agent ? ["--agent", agent] : []), ...args];
    return run(argv, { timeoutMs: timeoutMs + 2_000, allowFailure: true, interactive, onStdout });
  }

  async listAdapters(): Promise<{ mac: string; name: string; default: boolean }[]> {
    const result = await this.bt(["list"], 8_000, undefined, true);
    const lines = result.stdout.split(/\r?\n/);
    const adapters: { mac: string; name: string; default: boolean }[] = [];
    for (const line of lines) {
      const match = line.match(/^Controller\s+([0-9A-F:]{17})\s+(.+?)(?:\s+\[default\])?\s*$/i);
      if (match) {
        adapters.push({
          mac: normalizeMac(match[1]!),
          name: match[2]!.trim(),
          default: /\[default\]/i.test(line),
        });
      }
    }
    return adapters;
  }

  private async resolveAdapter(): Promise<string> {
    if (this.selectedAdapter) return this.selectedAdapter;
    try {
      const adapters = await this.listAdapters();
      const firstAdapter = adapters[0];
      if (!firstAdapter) {
        throw new Error("No Bluetooth controllers found");
      }
      if (adapters.length === 1) {
        this.selectedAdapter = firstAdapter.mac;
        return this.selectedAdapter;
      }
      let bestMac = firstAdapter.mac;
      let maxScore = -1;
      for (const adapter of adapters) {
        let score = 0;
        if (adapter.default) score += 5;
        const details = await this.bt(["show", adapter.mac], 8_000, undefined, true).catch(() => null);
        if (details && details.exitCode === 0) {
          if (/Powered:\s*yes/i.test(details.stdout)) score += 10;
          if (/Discoverable:\s*yes/i.test(details.stdout)) score += 1;
          if (/Pairable:\s*yes/i.test(details.stdout)) score += 1;
          if (/Discovering:\s*yes/i.test(details.stdout)) score += 1;
          
          const hasLe = /Roles:\s*central|Roles:\s*peripheral|Advertising Features:/i.test(details.stdout);
          const hasClassic = !/LE-only/i.test(details.stdout);
          if (hasLe) score += 5;
          if (hasClassic) score += 5;
        }
        if (score > maxScore) {
          maxScore = score;
          bestMac = adapter.mac;
        }
      }
      this.selectedAdapter = bestMac;
      return this.selectedAdapter;
    } catch (error) {
      return "00:00:00:00:00:00";
    }
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

  async hasAdapterCapability(cap: "le" | "bredr"): Promise<boolean> {
    if (this.dryRun) return true;
    const adapter = await this.adapterMac().catch(() => null);
    if (!adapter) return false;
    const details = await this.bt(["show", adapter], 8_000, undefined, true).catch(() => null);
    if (!details || details.exitCode !== 0) return false;
    if (cap === "le") {
      return /Roles:\s*central|Roles:\s*peripheral|Advertising Features:/i.test(details.stdout);
    } else {
      return !/LE-only/i.test(details.stdout);
    }
  }

  async scanLive(mode: ScanMode, seconds: number, options: {
    signal?: AbortSignal;
    onSeen?: (mac: string) => void;
    onDevice?: (device: DeviceState) => void;
  } = {}): Promise<DeviceState[]> {
    if (!(["bredr", "le", "on"] as string[]).includes(mode)) throw new Error(`Invalid scan mode: ${mode}`);
    if (this.dryRun) return this.devices();
    if (options.signal?.aborted) return [];
    if (!this.selectedAdapter) {
      await this.resolveAdapter().catch(() => {});
    }
    await this.hardenAdapter().catch(() => {});
    if (mode === "le" && !await this.hasAdapterCapability("le")) {
      throw new Error(`Controller ${this.selectedAdapter || ""} does not support Low Energy (LE) scans`);
    }
    if (mode === "bredr" && !await this.hasAdapterCapability("bredr")) {
      throw new Error(`Controller ${this.selectedAdapter || ""} does not support Classic (BR/EDR) scans`);
    }
    const duration = Math.max(1, seconds);
    const session = Bun.spawn(["bluetoothctl"], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe", env: defaultEnv(),
    });
    const abortSession = () => { if (session.exitCode === null) session.kill("SIGKILL"); };
    options.signal?.addEventListener("abort", abortSession, { once: true });
    const seen = new Map<string, DeviceState>();
    const onLine = (line: string) => {
      const event = parseDiscoveryLine(line);
      if (!event) return;
      options.onSeen?.(event.mac);

      const previous = seen.get(event.mac);
      const name = event.name ?? previous?.name;
      const alias = event.name ?? previous?.alias;
      const rssi = event.rssi ?? previous?.rssi;
      const devClass = event.class ?? previous?.class;
      const icon = event.icon ?? previous?.icon;

      // Only trigger updates if there is new information
      const hasUpdate = !previous ||
        (event.name !== undefined && previous.name !== event.name) ||
        (event.rssi !== undefined && previous.rssi !== event.rssi) ||
        (event.class !== undefined && previous.class !== event.class) ||
        (event.icon !== undefined && previous.icon !== event.icon);

      if (!hasUpdate) return;

      const device: DeviceState = {
        ...parseDeviceInfo("", event.mac),
        name,
        alias,
        rssi,
        class: devClass,
        icon,
      };

      seen.set(event.mac, device);
      options.onDevice?.(device);
    };
    const output = Promise.all([consumeLines(session.stdout, onLine), consumeLines(session.stderr, onLine)]);
    try {
      const stdin = session.stdin;
      if (!stdin) throw new Error("Could not open bluetoothctl scan session");
      const selectCmd = this.selectedAdapter ? `select ${this.selectedAdapter}\n` : "";
      stdin.write(`${selectCmd}scan off\nscan ${mode}\n`);
      const deadline = Date.now() + duration * 1_000;
      while (Date.now() < deadline && !options.signal?.aborted) await Bun.sleep(Math.min(100, deadline - Date.now()));
      if (!options.signal?.aborted) {
        stdin.write("scan off\nquit\n");
        stdin.end();
      }
      const exit = await new Promise<number>(resolve => {
        const timer = setTimeout(() => resolve(124), 10_000);
        session.exited.then(code => { clearTimeout(timer); resolve(code); });
      });
      if (exit === 124) session.kill("SIGKILL");
      const [stdout, stderr] = await output;
      if (!options.signal?.aborted && !/Discovery started|SetDiscoveryFilter success|Changing power on succeeded/i.test(`${stdout}\n${stderr}`)) {
        throw new Error(`BlueZ did not confirm discovery start: ${(stderr || stdout).trim()}`);
      }
    } finally {
      options.signal?.removeEventListener("abort", abortSession);
      if (session.exitCode === null) session.kill("SIGKILL");
      await this.stopScan(2_000).catch(error => {
        log("scan.stop.failed", { error: String(error) });
      });
    }
    const liveDevices = [...seen.values()];
    if (options.signal?.aborted || !liveDevices.length) return liveDevices;

    const cachedDevices = await this.devices().catch(() => []);
    const cachedByMac = new Map(cachedDevices.map(device => [device.mac, device]));
    return liveDevices.map(device => {
      const cached = cachedByMac.get(device.mac);
      if (!cached) return device;
      return {
        ...cached,
        ...device,
        name: device.name ?? cached.name,
        alias: device.alias ?? cached.alias,
      };
    });
  }

  async scan(mode: ScanMode, seconds: number): Promise<DeviceState[]> {
    return this.scanLive(mode, seconds);
  }

  async stopScan(timeoutMs = 8_000): Promise<void> { if (!this.dryRun) await this.bt(["scan", "off"], timeoutMs); }

  async isRfkillBlocked(): Promise<boolean> {
    if (!await commandExists("rfkill")) return false;
    const result = await run(["rfkill", "list", "bluetooth"], { allowFailure: true, timeoutMs: 5_000 });
    return /Soft blocked:\s*yes|Hard blocked:\s*yes/i.test(result.stdout);
  }

  async unblockRfkill(): Promise<void> {
    if (!await commandExists("rfkill")) return;
    await this.privileged(["rfkill", "unblock", "bluetooth"]).catch(error => {
      log("rfkill.unblock.failed", { error: String(error) });
    });
  }

  async unblock(mac: string): Promise<void> {
    if (this.dryRun) return;
    const result = await this.bt(["unblock", normalizeMac(mac)]);
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || "Unblock failed");
  }

  async prepare(): Promise<void> {
    if (this.dryRun) return;
    if (await this.isRfkillBlocked()) {
      log("rfkill.unblock.start", {});
      await this.unblockRfkill();
    }
    for (const args of [["power", "on"], ["pairable", "on"], ["scan", "off"]]) await this.bt(args);
  }

  async pair(mac: string, agent: Agent, timeoutMs: number, legacyPin?: string): Promise<RunResult> {
    if (this.dryRun) return { argv: [], exitCode: 0, stdout: "dry-run", stderr: "", timedOut: false };
    const interactive = agent !== "NoInputNoOutput";
    const onStdout = legacyPin ? (text: string, writeStdin: (chunk: string) => void) => {
      if (/Enter PIN code:/i.test(text)) {
        log("agent.legacy-pin", { mac, pin: legacyPin });
        writeStdin(`${legacyPin}\n`);
      }
    } : undefined;
    const result = await this.bt(["pair", normalizeMac(mac)], timeoutMs, agent, false, interactive, onStdout);
    if (result.exitCode !== 0) throw new Error(`${result.timedOut ? "Pairing timed out\n" : ""}${result.stderr || result.stdout || "Pairing failed"}`);
    return result;
  }

  async pairAndConnect(mac: string, agent: Agent, timeoutMs: number, legacyPin?: string): Promise<RunResult> {
    if (this.dryRun) return { argv: [], exitCode: 0, stdout: "dry-run", stderr: "", timedOut: false };
    mac = normalizeMac(mac);
    if (!this.selectedAdapter) {
      await this.resolveAdapter().catch(() => {});
    }

    const argv = ["bluetoothctl", "--timeout", String(Math.max(1, Math.ceil(timeoutMs / 1_000))), "--agent", agent];
    const selectCmd = this.selectedAdapter ? `select ${this.selectedAdapter}\n` : "";
    const input = `${selectCmd}pair ${mac}\n`;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const clearTimers = () => {
      while (timers.length) {
        const timer = timers.pop();
        if (timer) clearTimeout(timer);
      }
    };
    let accumulated = "";
    let pairSucceeded = false;
    let followupScheduled = false;
    let quitWritten = false;
    const writeSafe = (writeStdin: (chunk: string) => void, chunk: string) => {
      try { writeStdin(chunk); } catch {}
    };
    const writeQuit = (writeStdin: (chunk: string) => void) => {
      if (quitWritten) return;
      quitWritten = true;
      clearTimers();
      writeSafe(writeStdin, "quit\n");
    };
    const schedule = (delayMs: number, writeStdin: (chunk: string) => void, chunk: string) => {
      timers.push(setTimeout(() => {
        if (!quitWritten) writeSafe(writeStdin, chunk);
      }, delayMs));
    };
    const scheduleFollowup = (writeStdin: (chunk: string) => void) => {
      if (followupScheduled) return;
      followupScheduled = true;
      log("pair.session-keepalive", { mac, message: "Pairing succeeded; keeping bluetoothctl alive to trust/connect before the remote can drop the transient link." });
      schedule(250, writeStdin, `trust ${mac}\n`);
      schedule(750, writeStdin, `connect ${mac}\n`);
      schedule(2_500, writeStdin, `connect ${mac} 0000110b-0000-1000-8000-00805f9b34fb\n`);
      schedule(4_500, writeStdin, `connect ${mac} 0000110e-0000-1000-8000-00805f9b34fb\n`);
      schedule(6_500, writeStdin, `info ${mac}\n`);
      timers.push(setTimeout(() => writeQuit(writeStdin), 9_000));
    };

    const result = await run(argv, {
      timeoutMs: timeoutMs + 12_000,
      allowFailure: true,
      input,
      keepStdinOpen: true,
      onStdout: (text, writeStdin) => {
        accumulated += text;
        if (legacyPin && /Enter PIN code:/i.test(text)) {
          log("agent.legacy-pin", { mac, pin: legacyPin });
          writeSafe(writeStdin, `${legacyPin}\n`);
        }
        if (!pairSucceeded && /Pairing successful/i.test(accumulated)) {
          pairSucceeded = true;
          scheduleFollowup(writeStdin);
        }
        if (!pairSucceeded && /Failed to pair|AuthenticationFailed|org\.bluez\.Error/i.test(accumulated)) {
          writeQuit(writeStdin);
        }
      },
    }).finally(clearTimers);

    const combined = `${result.stdout}\n${result.stderr}`;
    if (!pairSucceeded && /Pairing successful/i.test(combined)) pairSucceeded = true;
    if (!pairSucceeded) {
      result.exitCode = result.exitCode === 0 ? 1 : result.exitCode;
      throw new Error(`${result.timedOut ? "Pairing timed out\n" : ""}${result.stderr || result.stdout || "Pairing failed"}`);
    }
    if (result.exitCode === 124) {
      throw new Error(`Pair/connect session timed out\n${result.stderr || result.stdout || "Pairing failed"}`);
    }
    result.exitCode = 0;
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
    mac = normalizeMac(mac);
    await this.stopScan(2_000).catch(error => {
      log("connect.scan-off.failed", { mac, profile: profile ?? "default", error: String(error) });
    });
    const result = await this.bt(["connect", mac, ...(profile ? [profile] : [])], timeoutMs);
    const output = `${result.stdout}\n${result.stderr}`;
    const commandSucceeded = connectOutputShowsCommandSuccess(output);
    const state = await this.info(mac).catch(() => null);
    if (profile) {
      if (result.exitCode === 0 && commandSucceeded && state?.connected) return;
      if (result.exitCode === 0 && commandSucceeded) {
        throw new Error("BlueZ reported a profile connection, but the device was disconnected when re-read");
      }
    } else if (state?.connected) {
      return;
    }
    if (result.exitCode !== 0) {
      if (connectOutputShowsConnected(output) && !/Failed to connect/i.test(output)) {
        throw new Error("BlueZ reported a transient connection, but the device was disconnected when re-read");
      }
      throw new Error(summarizeBluetoothctlFailure(output, "Connection failed"));
    }
    if (profile && state?.connected) {
      throw new Error("BlueZ connected the device ACL, but did not confirm the requested profile connection");
    }
    if (connectOutputShowsProgress(output)) {
      throw new Error("BlueZ connect is still in progress; device was not connected when re-read");
    }
    if (connectOutputShowsConnected(output)) {
      throw new Error("BlueZ reported Connected: yes, but the device was disconnected when re-read");
    }
    throw new Error(summarizeBluetoothctlFailure(output, "Connect command finished without a persistent Connected: yes state"));
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
    if (this.selectedAdapter) return this.selectedAdapter;
    const result = await this.bt(["list"], 8_000, undefined, true);
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

  async findCompetingManagers(): Promise<string[]> {
    if (!await commandExists("pgrep")) return [];
    const pattern = "blueman|Blueman|gnome-bluetooth|bluedevil|cosmic-applet-bluetooth|blauwerk-scanner|src/cli\\.ts daemon";
    const result = await run(["pgrep", "-a", "-f", pattern], { allowFailure: true, timeoutMs: 5_000 });
    if (result.exitCode !== 0) return [];
    return result.stdout.split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .filter(line => !/\bpgrep\b/.test(line));
  }

  private async kernelModuleLoaded(name: string): Promise<boolean | undefined> {
    if (!await commandExists("lsmod")) return undefined;
    const result = await run(["lsmod"], { allowFailure: true, timeoutMs: 5_000 });
    if (result.exitCode !== 0) return undefined;
    return new RegExp(`^${name}\\s`, "m").test(result.stdout);
  }

  async hostState(): Promise<BluetoothHostState> {
    const adapters = await this.listAdapters().catch(() => []);
    const preferred = this.selectedAdapter ?? adapters.find(adapter => adapter.default)?.mac ?? adapters[0]?.mac;
    const showCmd = preferred ? ["show", preferred] : ["show"];
    const [show, managers, btusbLoaded] = await Promise.all([
      this.bt(showCmd, 8_000, undefined, true).catch(error => ({
        exitCode: 1,
        stdout: "",
        stderr: String(error),
        timedOut: false,
        argv: [],
      } satisfies RunResult)),
      this.findCompetingManagers().catch(() => []),
      this.kernelModuleLoaded("btusb"),
    ]);
    const controller = parseControllerState(`${show.stdout}\n${show.stderr}`);
    return {
      ...controller,
      controllerAvailable: controller.controllerAvailable && show.exitCode === 0,
      btusbLoaded,
      competingManagers: managers,
      backgroundScannerActive: managers.some(manager => /blauwerk-scanner|src\/cli\.ts daemon/i.test(manager)),
    };
  }

  private hostIssues(state: BluetoothHostState): string[] {
    const issues: string[] = [];
    if (!state.controllerAvailable && state.btusbLoaded === false) {
      issues.push("Bluetooth controller is unavailable because btusb is not loaded; run: sudo modprobe btusb && sudo systemctl restart bluetooth");
    } else if (!state.controllerAvailable) {
      issues.push("No Bluetooth controller is available to BlueZ; restart bluetooth or reset the adapter");
    }
    if (state.powerTransitionStuck) {
      issues.push(`Bluetooth controller is stuck in PowerState=${state.powerState}; a bluetoothd kill/start or btusb reset may be required`);
    }
    if (state.discovering && state.backgroundScannerActive) {
      issues.push("Background Blauwerk scanner is active while the controller is discovering; stop it before audio recovery");
    } else if (state.discovering && state.competingManagers.length > 0) {
      issues.push("Controller is already discovering while Bluetooth manager applets are active; this can cause br-connection-busy during profile connect");
    }
    return issues;
  }

  async checkAudioConflicts(): Promise<{ pulseaudio: boolean; pipewire: boolean; conflict: boolean }> {
    if (!await commandExists("pgrep")) return { pulseaudio: false, pipewire: false, conflict: false };
    const pulseResult = await run(["pgrep", "-x", "pulseaudio"], { allowFailure: true, timeoutMs: 3_000 });
    const pwResult = await run(["pgrep", "-x", "pipewire"], { allowFailure: true, timeoutMs: 3_000 });
    const pulseaudio = pulseResult.exitCode === 0;
    const pipewire = pwResult.exitCode === 0;
    return {
      pulseaudio,
      pipewire,
      conflict: pulseaudio && pipewire,
    };
  }

  async diagnostics(): Promise<Record<string, string>> {
    const output: Record<string, string> = {};
    if (!this.selectedAdapter) {
      await this.resolveAdapter().catch(() => {});
    }
    const controllerCmd = this.selectedAdapter ? ["bluetoothctl", "show", this.selectedAdapter] : ["bluetoothctl", "show"];
    for (const [name, argv] of Object.entries({ controllers: ["bluetoothctl", "list"], controller: controllerCmd, rfkill: ["rfkill", "list", "bluetooth"], audio: ["wpctl", "status"] })) {
      if (await commandExists(argv[0]!)) {
        const result = await run(argv, { allowFailure: true, timeoutMs: 10_000 });
        output[name] = `${result.stdout}${result.stderr}`.trim();
      }
    }
    const managers = await this.findCompetingManagers().catch(() => []);
    if (managers.length > 0) {
      output["competing_managers"] = managers.join("\n");
    }
    const host = await this.hostState().catch(() => undefined);
    if (host) {
      output["bluetooth_host"] = [
        `controller: ${host.controllerAvailable ? host.controllerMac ?? "available" : "unavailable"}`,
        `powered: ${host.powered ?? "unknown"}`,
        `power_state: ${host.powerState ?? "unknown"}`,
        `discovering: ${host.discovering ?? "unknown"}`,
        `btusb_loaded: ${host.btusbLoaded ?? "unknown"}`,
        `background_scanner_active: ${host.backgroundScannerActive}`,
      ].join("\n");
      const hostIssues = this.hostIssues(host);
      if (hostIssues.length > 0) output["detected_bluetooth_issues"] = hostIssues.join("\n");
    }
    const conflicts = await this.checkAudioConflicts().catch(() => null);
    if (conflicts) {
      output["audio_conflicts"] = `pulseaudio: ${conflicts.pulseaudio ? "active" : "inactive"}\npipewire: ${conflicts.pipewire ? "active" : "inactive"}\nconflict: ${conflicts.conflict ? "YES" : "NO"}`;
    }
    return output;
  }

  async hardenAdapter(): Promise<void> {
    if (this.dryRun) return;
    await this.bt(["discoverable", "off"], 8_000);
    await this.bt(["pairable", "off"], 8_000);
  }
}
