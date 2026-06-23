#!/usr/bin/env bun
import { Bluez, normalizeMac } from "./bluez";
import { AudioManager } from "./audio";
import { capabilities, DeviceCatalog } from "./catalog";
import { auditBluezConfig, fixBluezConfig } from "./config";
import { adapterPowerState, disableAdapterAutosuspend } from "./power";
import { runDashboard } from "./dashboard";
import { logPath } from "./log";
import { aggressiveMatrix, healthy, Recovery, safeMatrix } from "./matrix";
import { failureScenarios, scenarioCoverage } from "./scenarios";

const VERSION = "0.2.0";
const args = Bun.argv.slice(2);
const command = args[0]?.startsWith("-") ? "dashboard" : (args.shift() ?? "dashboard");
const flag = (name: string) => args.includes(name);
const value = (name: string, fallback?: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const number = (name: string, fallback: number) => { const parsed = Number(value(name, String(fallback))); if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a positive number`); return parsed; };

function help(): void {
  console.log(`blauwerk ${VERSION} — resilient Bluetooth management

Usage:
  blauwerk                            # interactive device dashboard
  blauwerk dashboard [--no-scan]
  blauwerk doctor --mac MAC [--aggressive]
  blauwerk doctor --hint "device name"
  blauwerk doctor                 # scan and select interactively
  blauwerk scan [--mode bredr|le|on] [--seconds 12]
  blauwerk ls [--scan] [--seconds 8]
  blauwerk explore [--seconds 8]
  blauwerk devices
  blauwerk inspect MAC
  blauwerk status MAC
  blauwerk audio MAC [--fix]
  blauwerk connect --mac MAC
  blauwerk disconnect --mac MAC
  blauwerk diagnose
  blauwerk config [--fix]
  blauwerk power [--fix]
  blauwerk coverage [--json]

Options:
  --mac MAC             target device
  --hint TEXT           match MAC/name after scanning
  --aggressive          allow cache purge/controller powercycle
  --dry-run             report mutating actions without executing them
  --no-sudo             reject privileged actions
  --scan-seconds N      scan duration per recovery attempt (default 12)
  --pair-timeout N      seconds (default 55)
  --connect-timeout N   seconds (default 25)
  --bond-wait N         seconds to wait for Bonded=yes (default 15)
  --require-bond        continue escalation after a usable unbonded connection
  --allow-session-drop  permit a temporary disconnect during safe rebond probing
  --ignore-config       run doctor despite audited BlueZ config errors
  --json                 machine-readable output
  --yes                  skip pairing-mode confirmation
  --no-scan              show known devices without discovery

Recovery is convergent: already satisfied state is retained, privileged
escalations run at most once, and cache purge requires --aggressive.
Log: ${logPath}`);
}

const json = flag("--json");
const print = (data: unknown) => console.log(json ? JSON.stringify(data, null, 2) : typeof data === "string" ? data : Bun.inspect(data, { colors: true }));
const requireMac = () => normalizeMac(value("--mac") ?? args[0] ?? (() => { throw new Error("a MAC or --mac is required"); })());

function recoveryFor(bluez: Bluez): Recovery {
  return new Recovery(bluez, {
    scanSeconds: number("--scan-seconds", 12), pairTimeoutMs: number("--pair-timeout", 55) * 1_000,
    connectTimeoutMs: number("--connect-timeout", 25) * 1_000,
    bondWaitMs: number("--bond-wait", 15) * 1_000,
    requireBond: flag("--require-bond"),
    allowSessionDrop: flag("--allow-session-drop") || flag("--require-bond"),
  });
}

async function ensurePlayback(bluez: Bluez, state: Awaited<ReturnType<Bluez["info"]>>) {
  return state.connected && capabilities(state).audioSink ? new AudioManager().ensure(bluez, state.mac) : undefined;
}

function table(devices: Awaited<ReturnType<DeviceCatalog["list"]>>): void {
  console.log(`${"#".padEnd(3)} ${"MAC".padEnd(17)}  ${"P/B/C".padEnd(5)}  ${"NAME".padEnd(30)}  CAPABILITIES`);
  devices.forEach((device, index) => {
    const state = `${device.paired ? "P" : "-"}/${device.bonded ? "B" : "-"}/${device.connected ? "C" : "-"}`;
    console.log(`${String(index + 1).padEnd(3)} ${device.mac}  ${state.padEnd(5)}  ${(device.alias ?? device.name ?? "unknown").slice(0, 30).padEnd(30)}  ${capabilities(device).labels.join(", ") || "unknown"}`);
  });
}

async function explore(bluez: Bluez): Promise<void> {
  const catalog = new DeviceCatalog(bluez);
  console.error(`Scanning BR/EDR and all bearers for ${number("--seconds", 8)}s each...`);
  const devices = await catalog.list({ scan: true, seconds: number("--seconds", 8) });
  if (json) return print(devices.map(device => ({ ...device, capabilities: capabilities(device) })));
  table(devices);
  if (!devices.length || !process.stdin.isTTY) return;
  const answer = prompt("Device number or MAC (empty to quit):")?.trim();
  if (!answer) return;
  const device = /^\d+$/.test(answer) ? devices[Number(answer) - 1] : devices.find(item => item.mac === normalizeMac(answer));
  if (!device) throw new Error("Invalid device selection");
  print({ ...(await catalog.inspect(device.mac)), audio: await new AudioManager().state(device.mac) });
  const action = prompt("[c]onnect, [d]octor, [x] disconnect, [q]uit:")?.trim().toLowerCase();
  if (action === "c") {
    let state = await bluez.info(device.mac);
    if (!state.paired) {
      console.error("Device is not paired; running the safe recovery flow first.");
      state = await recoveryFor(bluez).run(device.mac, safeMatrix);
    } else {
      await bluez.trust(device.mac); await bluez.connect(device.mac);
      state = await bluez.info(device.mac);
    }
    print({ bluetooth: state, capabilities: capabilities(state), audio: await ensurePlayback(bluez, state) });
  } else if (action === "d") {
    const state = await recoveryFor(bluez).run(device.mac, flag("--aggressive") ? aggressiveMatrix : safeMatrix);
    print({ bluetooth: state, capabilities: capabilities(state), audio: await ensurePlayback(bluez, state) });
  } else if (action === "x") {
    await bluez.disconnect(device.mac); print(await bluez.info(device.mac));
  }
}

async function selectTarget(bluez: Bluez): Promise<string> {
  const explicit = value("--mac");
  if (explicit) return normalizeMac(explicit);
  let devices = await bluez.devices();
  const hint = value("--hint")?.toLowerCase();
  let matches = hint ? devices.filter(device => `${device.mac} ${device.name ?? ""}`.toLowerCase().includes(hint)) : devices;
  if (!matches.length) {
    devices = [...await bluez.scan("bredr", number("--scan-seconds", 12)), ...await bluez.scan("on", number("--scan-seconds", 12))];
    const unique = new Map(devices.map(device => [device.mac, device]));
    devices = [...unique.values()];
    matches = hint ? devices.filter(device => `${device.mac} ${device.name ?? ""}`.toLowerCase().includes(hint)) : devices;
  }
  if (matches.length === 1) return matches[0]!.mac;
  if (!matches.length) throw new Error(hint ? `No device matches --hint ${JSON.stringify(hint)}` : "No Bluetooth devices found");
  if (!process.stdin.isTTY || json) throw new Error("Multiple devices found; specify --mac or --hint");
  matches.forEach((device, index) => console.log(`${index + 1}) ${device.mac}  ${device.name ?? "unknown"}`));
  const answer = prompt("Device number or MAC:")?.trim() ?? "";
  if (/^\d+$/.test(answer)) {
    const selected = matches[Number(answer) - 1];
    if (selected) return selected.mac;
  }
  return normalizeMac(answer);
}

async function main(): Promise<void> {
  if (flag("--help") || flag("-h") || command === "help") return help();
  if (flag("--version")) return console.log(VERSION);
  if (command === "coverage") {
    const coverage = scenarioCoverage();
    if (json) return print({ coverage, scenarios: failureScenarios });
    console.log(`Failure-mode coverage: ${coverage.guidance}/${coverage.total} catalogued with observe/guidance/verify playbooks`);
    console.log(`Implementation: ${coverage.handled} handled, ${coverage.partial} partial, ${coverage.planned} planned, ${coverage.manual} manual`);
    console.log("\nCategories:");
    for (const [category, count] of Object.entries(coverage.byCategory)) console.log(`  ${category.padEnd(12)} ${count}`);
    console.log("\nThis is catalog coverage, not a claim that every device can be repaired automatically.");
    return;
  }
  const bluez = new Bluez(flag("--dry-run"), flag("--no-sudo"));
  await bluez.assertReady();
  switch (command) {
    case "dashboard": return runDashboard(bluez, {
      scan: !flag("--no-scan"), scanSeconds: number("--seconds", 6), json,
      pairTimeoutMs: number("--pair-timeout", 55) * 1_000,
      connectTimeoutMs: number("--connect-timeout", 25) * 1_000,
      bondWaitMs: number("--bond-wait", 15) * 1_000,
    });
    case "devices": return print(await bluez.devices());
    case "scan": return print(await bluez.scan((value("--mode", "on") as "bredr" | "le" | "on"), number("--seconds", 12)));
    case "ls": {
      const devices = await new DeviceCatalog(bluez).list({ scan: flag("--scan"), seconds: number("--seconds", 8) });
      if (json) return print(devices.map(device => ({ ...device, capabilities: capabilities(device) })));
      return table(devices);
    }
    case "explore": return explore(bluez);
    case "inspect": {
      const mac = requireMac();
      return print({ ...(await new DeviceCatalog(bluez).inspect(mac)), audio: await new AudioManager().state(mac) });
    }
    case "status": {
      const mac = requireMac();
      return print({ bluetooth: await bluez.info(mac), audio: await new AudioManager().state(mac) });
    }
    case "audio": {
      const mac = requireMac();
      if (!flag("--fix")) return print(await new AudioManager().state(mac));
      return print(await new AudioManager().ensure(bluez, mac));
    }
    case "connect": {
      const mac = requireMac();
      await bluez.trust(mac);
      if (!(await bluez.info(mac)).connected) await bluez.connect(mac);
      const state = await bluez.info(mac);
      return print({ bluetooth: state, capabilities: capabilities(state), audio: await ensurePlayback(bluez, state) });
    }
    case "disconnect": await bluez.disconnect(requireMac()); return print(await bluez.info(requireMac()));
    case "diagnose": return print(await bluez.diagnostics());
    case "config": {
      const issues = await auditBluezConfig();
      if (!flag("--fix")) return print({ path: "/etc/bluetooth/main.conf", issues });
      const result = await fixBluezConfig();
      return print({ ...result, remainingIssues: await auditBluezConfig() });
    }
    case "power": {
      if (!flag("--fix")) return print(adapterPowerState());
      return print(await disableAdapterAutosuspend(true));
    }
    case "doctor": {
      const configIssues = await auditBluezConfig().catch(() => []);
      for (const issue of configIssues) console.error(`[config.${issue.severity}] [${issue.section}] ${issue.key}=${issue.value}: ${issue.message}`);
      const configErrors = configIssues.filter(issue => issue.severity === "error");
      if (configErrors.length && !flag("--ignore-config")) {
        throw new Error(`BlueZ configuration has ${configErrors.length} errors; run 'blauwerk config --fix' or explicitly pass --ignore-config`);
      }
      const power = adapterPowerState();
      if (power.control === "auto") console.error(`[power.warning] adapter ${power.vendor}:${power.product} uses USB autosuspend after ${power.autosuspendDelayMs}ms; run 'blauwerk power --fix'`);
      const mac = await selectTarget(bluez);
      if (!flag("--yes") && process.stdin.isTTY) {
        console.error(`Target: ${mac}\nPut it in normal host pairing mode; disable competing phones and TWS mode.`);
        if (flag("--require-bond")) console.error("Rebonding may briefly stop a working connection; device state is removed only after a live discovery hit.");
        if ((prompt("Continue? [Y/n]") ?? "y").trim().toLowerCase().startsWith("n")) return;
      }
      const recovery = recoveryFor(bluez);
      const state = await recovery.run(mac, flag("--aggressive") ? aggressiveMatrix : safeMatrix);
      const audio = await ensurePlayback(bluez, state);
      print({ bluetooth: state, capabilities: capabilities(state), audio });
      if (!state.paired) process.exitCode = 1;
      else if (!healthy(state) || (capabilities(state).audioSink && !audio?.sinkFound)) process.exitCode = 2;
      return;
    }
    default: throw new Error(`Unknown command: ${command}`);
  }
}

main().catch(error => { console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`); console.error(`Log: ${logPath}`); process.exitCode = 1; });
