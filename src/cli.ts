#!/usr/bin/env bun
import { Bluez, normalizeMac } from "./bluez";
import { AudioManager } from "./audio";
import { capabilities, DeviceCatalog } from "./catalog";
import { auditBluezConfig, fixBluezConfig } from "./config";
import { adapterPowerState, disableAdapterAutosuspend } from "./power";
import { runDashboard } from "./dashboard";
import { adviseDevice } from "./advisor";
import { logPath } from "./log";
import { aggressiveMatrix, healthy, Recovery, safeMatrix } from "./matrix";
import { failureScenarios, scenarioCoverage } from "./scenarios";
import { runSimulation } from "./simulate";
import { DeviceRegistry } from "./registry";
import { runDaemon, installDaemon, startDaemon, stopDaemon, getDaemonStatus } from "./daemon";

const VERSION = "0.4.9";
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
  blauwerk simulate TYPE              # run simulated recovery (stale-link-key, multipoint-conflict, pairing-agent)
  blauwerk registry [--json]          # list historically seen devices
  blauwerk daemon --run               # run background scanner in foreground
  blauwerk daemon --install           # install background scanner systemd user service
  blauwerk daemon --start             # enable & start background scanner service
  blauwerk daemon --stop              # disable & stop background scanner service
  blauwerk daemon --status            # check background scanner service status

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
  --no-bond             do not force bonding by default for input devices
  --allow-session-drop  permit a temporary disconnect during safe rebond probing
  --ignore-config       run doctor despite audited BlueZ config errors
  --json                 machine-readable output
  --non-interactive     skip interactive goals prompt in doctor
  --yes                  skip pairing-mode confirmation
  --no-scan              show known devices without discovery
  --interval N           daemon scan interval in seconds (default 300)
  --seconds N            daemon scan duration in seconds (default 30)

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
  return capabilities(state).audioSink ? new AudioManager().ensure(bluez, state.mac) : undefined;
}

function table(devices: Awaited<ReturnType<DeviceCatalog["list"]>>): void {
  console.log(`${"#".padEnd(3)} ${"MAC".padEnd(17)}  ${"P/B/C".padEnd(5)}  ${"NAME".padEnd(30)}  CAPABILITIES`);
  devices.forEach((device, index) => {
    const state = `${device.paired ? "P" : "-"}/${device.bonded ? "B" : "-"}/${device.connected ? "C" : "-"}`;
    const batteryText = device.battery !== undefined ? ` (${device.battery}%)` : "";
    const name = `${device.alias ?? device.name ?? "unknown"}${batteryText}`;
    console.log(`${String(index + 1).padEnd(3)} ${device.mac}  ${state.padEnd(5)}  ${name.slice(0, 30).padEnd(30)}  ${capabilities(device).labels.join(", ") || "unknown"}`);
  });
}

function printDeviceDashboard(
  device: Awaited<ReturnType<Bluez["info"]>>,
  caps: ReturnType<typeof capabilities>,
  audio: any,
  configIssues: any[],
  power: any,
  optimizeLatency = false
): void {
  const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
  const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
  const yellow = (text: string) => `\x1b[33m${text}\x1b[0m`;
  const red = (text: string) => `\x1b[31m${text}\x1b[0m`;
  const blue = (text: string) => `\x1b[34m${text}\x1b[0m`;
  const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;
  
  const notices = adviseDevice(device, { audio, power, configIssues });
  
  console.log(`\n${bold("=".repeat(80))}`);
  console.log(`${bold(`  BLAUWERK DEVICE REPORT: ${device.alias ?? device.name ?? "Unknown Device"} (${device.mac})`)}`);
  console.log(`${bold("=".repeat(80))}`);
  
  console.log(`  ${bold("Device Metadata:")}`);
  console.log(`    Name/Alias:  ${device.alias ?? device.name ?? "unknown"}`);
  console.log(`    Address:     ${device.mac} (${device.addressType ?? "unknown"})`);
  if (device.icon) console.log(`    Icon:        ${device.icon}`);
  if (device.class) console.log(`    Class:       ${device.class}`);
  if (device.rssi !== undefined) {
    let signalQuality = "Good";
    if (device.rssi < -80) signalQuality = red("Poor");
    else if (device.rssi < -70) signalQuality = yellow("Moderate");
    else signalQuality = green("Good");
    console.log(`    Signal:      ${device.rssi} dBm (${signalQuality})`);
  }
  if (device.battery !== undefined) console.log(`    Battery:     ${device.battery}%`);
  
  console.log();
  console.log(`  ${bold("Connection State:")}`);
  console.log(`    Connected:   ${device.connected ? green("Yes  ●") : red("No  ○")}`);
  console.log(`    Paired:      ${device.paired ? green("Yes  ●") : red("No  ○")}`);
  console.log(`    Bonded:      ${device.bonded ? green("Yes  ● (Persistent link key stored)") : device.bonded === false ? red("No  ○ (Ephemeral pairing - will not auto-reconnect)") : yellow("Unknown  ○")}`);
  console.log(`    Trusted:     ${device.trusted ? green("Yes  ● (Auto-connection allowed)") : red("No  ○ (Connection authorization required)")}`);
  
  console.log();
  console.log(`  ${bold("Capabilities:")}`);
  console.log(`    Profiles:    ${caps.labels.join(", ") || "None recognized / proprietary"}`);
  console.log(`    Intents:     ${caps.intents.join(", ") || "none"}`);
  
  if (audio) {
    console.log();
    console.log(`  ${bold("Audio Subsystem:")}`);
    console.log(`    Audio Card:  ${audio.cardFound ? green("Found") : red("Not Found")}`);
    console.log(`    Audio Sink:  ${audio.sinkFound ? green("Active") : red("Inactive")}`);
    if (audio.activeProfile) console.log(`    Profile:     ${audio.activeProfile}`);
  }
  
  if (optimizeLatency || power || configIssues.length > 0) {
    console.log();
    console.log(`  ${bold("Host & Latency Optimization:")}`);
    
    const fastConnectableEnabled = !configIssues.some(issue => issue.section === "General" && issue.key === "FastConnectable" && issue.value === "false");
    const fcText = fastConnectableEnabled ? green("Enabled (reconnections will be fast)") : yellow("Disabled (reconnections might be sluggish)");
    console.log(`    Fast Connectable: ${fcText}`);
    
    if (power) {
      const psText = power.control === "on" ? green("Disabled (maximum stability)") : yellow("Enabled (potential latency/disconnect risk)");
      console.log(`    USB Autosuspend:  ${psText}`);
    }
  }
  
  console.log();
  console.log(`  ${bold("Diagnostics & Recommendations:")}`);
  if (notices.length === 0) {
    console.log(`    ${green("✔")} All checks passed. No issues detected.`);
  } else {
    notices.forEach((notice) => {
      const icon = notice.severity === "error" ? red("✘") : notice.severity === "warning" ? yellow("⚠") : blue("ℹ");
      console.log(`    ${icon} [${bold(notice.title)}]: ${notice.detail}`);
      if (notice.command) {
        console.log(`       ${dim("Recommendation:")} Run \`${notice.command}\``);
      }
    });
  }
  console.log(`${bold("=".repeat(80))}\n`);
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
  
  const inspectData = await catalog.inspect(device.mac);
  const audioState = await new AudioManager().state(device.mac);
  if (json) {
    print({ ...inspectData, audio: audioState });
  } else {
    const configIssues = await auditBluezConfig().catch(() => []);
    const power = adapterPowerState();
    printDeviceDashboard(inspectData.device, inspectData.capabilities, audioState, configIssues, power);
  }

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
    const audioState = await ensurePlayback(bluez, state);
    if (json) {
      print({ bluetooth: state, capabilities: capabilities(state), audio: audioState });
    } else {
      const configIssues = await auditBluezConfig().catch(() => []);
      const power = adapterPowerState();
      printDeviceDashboard(state, capabilities(state), audioState, configIssues, power);
    }
  } else if (action === "d") {
    const state = await recoveryFor(bluez).run(device.mac, flag("--aggressive") ? aggressiveMatrix : safeMatrix);
    const audioState = await ensurePlayback(bluez, state);
    if (json) {
      print({ bluetooth: state, capabilities: capabilities(state), audio: audioState });
    } else {
      const configIssues = await auditBluezConfig().catch(() => []);
      const power = adapterPowerState();
      printDeviceDashboard(state, capabilities(state), audioState, configIssues, power);
    }
  } else if (action === "x") {
    await bluez.disconnect(device.mac);
    const state = await bluez.info(device.mac);
    if (json) {
      print(state);
    } else {
      const configIssues = await auditBluezConfig().catch(() => []);
      const power = adapterPowerState();
      printDeviceDashboard(state, capabilities(state), undefined, configIssues, power);
    }
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
      const info = await new DeviceCatalog(bluez).inspect(mac);
      const audioState = await new AudioManager().state(mac);
      if (json) {
        return print({ ...info, audio: audioState });
      } else {
        const configIssues = await auditBluezConfig().catch(() => []);
        const power = adapterPowerState();
        return printDeviceDashboard(info.device, info.capabilities, audioState, configIssues, power);
      }
    }
    case "status": {
      const mac = requireMac();
      const state = await bluez.info(mac);
      const audioState = await new AudioManager().state(mac);
      if (json) {
        return print({ bluetooth: state, audio: audioState });
      } else {
        const configIssues = await auditBluezConfig().catch(() => []);
        const power = adapterPowerState();
        return printDeviceDashboard(state, capabilities(state), audioState, configIssues, power);
      }
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
      const audioState = await ensurePlayback(bluez, state);
      if (json) {
        return print({ bluetooth: state, capabilities: capabilities(state), audio: audioState });
      } else {
        const configIssues = await auditBluezConfig().catch(() => []);
        const power = adapterPowerState();
        return printDeviceDashboard(state, capabilities(state), audioState, configIssues, power);
      }
    }
    case "disconnect": await bluez.disconnect(requireMac()); return print(await bluez.info(requireMac()));
    case "diagnose": return print(await bluez.diagnostics());
    case "config": {
      const issues = await auditBluezConfig().catch(() => []);
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
      
      let requireBond = flag("--require-bond");
      let useAggressive = flag("--aggressive");
      let optimizeLatency = false;
      
      const initialInfo = await bluez.info(mac);
      const caps = capabilities(initialInfo);
      
      // If it's a human interface device (keyboard/mouse/gamepad), default to requireBond=true unless --no-bond is passed
      if (caps.humanInterface && !flag("--no-bond")) {
        requireBond = true;
      }
      
      const interactive = process.stdin.isTTY && !flag("--non-interactive") && !flag("--yes") && !json;
      
      if (interactive) {
        console.log(`\nTroubleshooting Goals for ${initialInfo.alias ?? initialInfo.name ?? mac}:`);
        console.log(`  1. Persistent Auto-Reconnect [${requireBond ? "Enabled (recommended for input devices)" : "Disabled"}]`);
        console.log(`     (Enforces bonding and trust so the device reconnects automatically on wake)`);
        console.log(`  2. Latency & Connection Speed Optimization [Disabled]`);
        console.log(`     (Checks for FastConnectable and connection interval settings)`);
        console.log(`  3. Aggressive Repair [${useAggressive ? "Enabled" : "Disabled"}]`);
        console.log(`     (Allows controller powercycle and host-side cache purge if standard repair fails)`);
        
        const answer = (prompt("\nSelect goals to enable (comma-separated, e.g. '1,2' or enter to keep defaults): ") ?? "").trim();
        if (answer) {
          const choices = answer.split(",").map(s => s.trim());
          if (choices.includes("1")) requireBond = true;
          if (choices.includes("2")) optimizeLatency = true;
          if (choices.includes("3")) useAggressive = true;
        }
      }
      
      if (!flag("--yes") && process.stdin.isTTY && !json) {
        console.error(`\nTarget: ${mac}`);
        console.error(`Put the device in normal host pairing mode; disable competing phones and TWS mode.`);
        if (requireBond) console.error("Rebonding may briefly stop a working connection; device state is removed only after a live discovery hit.");
        if ((prompt("Continue? [Y/n] ") ?? "y").trim().toLowerCase().startsWith("n")) return;
      }
      
      const recovery = new Recovery(bluez, {
        scanSeconds: number("--scan-seconds", 12),
        pairTimeoutMs: number("--pair-timeout", 55) * 1_000,
        connectTimeoutMs: number("--connect-timeout", 25) * 1_000,
        bondWaitMs: number("--bond-wait", 15) * 1_000,
        requireBond,
        allowSessionDrop: flag("--allow-session-drop") || requireBond,
      });
      
      const state = await recovery.run(mac, useAggressive ? aggressiveMatrix : safeMatrix);
      const audio = await ensurePlayback(bluez, state);
      
      if (json) {
        print({ bluetooth: state, capabilities: capabilities(state), audio });
      } else {
        printDeviceDashboard(state, capabilities(state), audio, configIssues, power, optimizeLatency);
      }
      
      const audioPlayable = Boolean(audio?.sinkFound);
      if (!state.paired && !audioPlayable) process.exitCode = 1;
      else if ((!healthy(state) && !audioPlayable) || (capabilities(state).audioSink && !audioPlayable)) process.exitCode = 2;
      return;
    }
    case "simulate": {
      const type = args[0] ?? "stale-link-key";
      if (!["stale-link-key", "multipoint-conflict", "pairing-agent"].includes(type)) {
        throw new Error(`Unknown simulation type: ${type}. Use: stale-link-key, multipoint-conflict, or pairing-agent`);
      }
      return runSimulation(type);
    }
    case "registry": {
      const registry = new DeviceRegistry();
      const list = registry.list().sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
      if (json) return print(list);
      if (list.length === 0) {
        console.log("No devices in registry.");
        return;
      }
      console.log(`${"LAST SEEN".padEnd(20)} ${"MAC".padEnd(17)}  ${"CAT".padEnd(9)}  ${"NAME / ALIAS".padEnd(30)}  CAPABILITIES`);
      for (const dev of list) {
        const lastSeenStr = dev.lastSeen.replace("T", " ").substring(0, 19);
        const catBadge = `[${dev.category.toUpperCase()}]`.padEnd(9);
        const name = dev.alias ?? dev.name ?? "unknown";
        console.log(`${lastSeenStr.padEnd(20)} ${dev.mac}  ${catBadge}  ${name.slice(0, 30).padEnd(30)}  ${dev.capabilities.join(", ") || "unknown"}`);
      }
      return;
    }
    case "daemon": {
      if (flag("--run")) {
        const interval = number("--interval", 300);
        const scanSecs = number("--seconds", 30);
        return runDaemon(interval, scanSecs);
      }
      if (flag("--install")) {
        const interval = number("--interval", 300);
        const scanSecs = number("--seconds", 30);
        return installDaemon(interval, scanSecs);
      }
      if (flag("--start")) {
        return startDaemon();
      }
      if (flag("--stop")) {
        return stopDaemon();
      }
      if (flag("--status")) {
        return print(await getDaemonStatus());
      }
      throw new Error("Specify one of: --run, --install, --start, --stop, --status for daemon command");
    }
    default: throw new Error(`Unknown command: ${command}`);
  }
}

main().catch(error => { console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`); console.error(`Log: ${logPath}`); process.exitCode = 1; });
