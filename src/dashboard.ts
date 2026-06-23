import { clearLine, createInterface, cursorTo } from "node:readline";
import { adviseDevice, type DeviceNotice } from "./advisor";
import { AudioManager } from "./audio";
import { Bluez } from "./bluez";
import { capabilities } from "./catalog";
import { auditBluezConfig, type ConfigIssue } from "./config";
import { Recovery, safeMatrix } from "./matrix";
import { adapterPowerState, type AdapterPowerState } from "./power";
import type { DeviceState } from "./types";
import { DeviceRegistry } from "./registry";
import { log } from "./log";

export interface DeviceGroups {
  known: DeviceState[];
  floating: DeviceState[];
}

export function partitionDevices(cached: DeviceState[], discovered: DeviceState[]): DeviceGroups {
  const known = cached.filter(device => device.paired || device.bonded || device.trusted || device.connected);
  const knownMacs = new Set(known.map(device => device.mac));
  const floating = [...new Map(discovered.filter(device => !knownMacs.has(device.mac)).map(device => [device.mac, device])).values()];
  return { known, floating };
}

export function supportsPlayback(device: DeviceState): boolean {
  return capabilities(device).audioSink;
}

export function parseDeviceSelection(value: string): number | undefined {
  const match = value.trim().match(/^(\d+)(?:\s+(?:check|checks|setting|settings))?$/i);
  return match ? Number(match[1]) - 1 : undefined;
}

function label(device: DeviceState, registry?: DeviceRegistry): string {
  const regDev = registry?.get(device.mac);
  return device.alias ?? device.name ?? regDev?.alias ?? regDev?.name ?? device.mac;
}

function actionable(notices: DeviceNotice[]): DeviceNotice[] {
  return notices.filter(notice => notice.severity !== "info" || notice.command);
}

function badge(notices: DeviceNotice[]): string {
  const count = actionable(notices).length;
  return count ? ` [! check: ${count} setting${count === 1 ? "" : "s"}]` : "";
}

async function enrich(bluez: Bluez, devices: DeviceState[]): Promise<DeviceState[]> {
  return Promise.all(devices.map(device => bluez.info(device.mac).catch(() => device)));
}

function printDeviceList(title: string, devices: DeviceState[], start: number, registry?: DeviceRegistry): number {
  console.log(`${title}:`);
  if (!devices.length) console.log("  (none)");
  devices.forEach((device, offset) => {
    const notices = adviseDevice(device);
    const state = device.connected ? "connected" : device.paired ? "paired" : "seen";
    const name = label(device, registry);
    const regDev = registry?.get(device.mac);
    const category = regDev?.category ?? "unknown";
    const catBadge = category !== "unknown" ? ` [${category.toUpperCase()}]` : "";
    console.log(` ${start + offset}. ${name}${catBadge}  (${state})${badge(notices)}`);
  });
  console.log();
  return start + devices.length;
}

async function liveDiscovery(bluez: Bluez, known: DeviceState[], seconds: number): Promise<{
  discovered: DeviceState[];
  selected?: DeviceState;
  quit: boolean;
}> {
  const registry = new DeviceRegistry();
  const knownByMac = new Map(known.map(device => [device.mac, device]));
  const floating = new Map<string, DeviceState>();
  const controller = new AbortController();
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let scanFinished = false;
  let settled = false;
  let settleSelection: (result: { selected?: DeviceState; quit: boolean }) => void = () => {};
  const selection = new Promise<{ selected?: DeviceState; quit: boolean }>(resolve => { settleSelection = resolve; });
  const all = () => [...knownByMac.values(), ...floating.values()];
  const promptText = "Select a device number or MAC at any time ([q]uit): ";
  rl.setPrompt(promptText);
  const printAbovePrompt = (message: string) => {
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
    console.log(message);
    rl.prompt(true);
  };

  const add = (device: DeviceState) => {
    if (knownByMac.has(device.mac)) return;
    const previous = floating.get(device.mac);
    
    // Record to registry to merge and classify
    registry.record(device);
    const regDev = registry.get(device.mac);
    const resolvedName = device.alias ?? device.name ?? regDev?.alias ?? regDev?.name ?? device.mac;
    const category = regDev?.category ?? "unknown";
    const catBadge = category !== "unknown" ? ` [${category.toUpperCase()}]` : "";

    floating.set(device.mac, { 
      ...previous, 
      ...device, 
      name: device.name ?? previous?.name ?? regDev?.name 
    });

    if (!previous) {
      const number = knownByMac.size + floating.size;
      printAbovePrompt(` ${number}. ${resolvedName}${catBadge}  (found)`);
    }
  };

  const choose = (value: string): DeviceState | undefined => {
    const index = parseDeviceSelection(value);
    if (index !== undefined) return all()[index];
    return all().find(device => device.mac.toLowerCase() === value.toLowerCase());
  };

  rl.on("line", line => {
    if (settled) return;
    const answer = line.trim();
    if (answer.toLowerCase() === "q" || (!answer && scanFinished)) {
      settled = true;
      controller.abort();
      settleSelection({ quit: true });
      return;
    }
    const selected = answer ? choose(answer) : undefined;
    if (selected) {
      settled = true;
      clearLine(process.stdout, 0);
      cursorTo(process.stdout, 0);
      console.log(`Selected: ${label(selected, registry)}; stopping discovery...`);
      controller.abort();
      settleSelection({ selected, quit: false });
      return;
    }
    if (answer) printAbovePrompt(`Device ${JSON.stringify(answer)} is not in the list yet.`);
    else rl.prompt(true);
  });
  rl.on("close", () => {
    if (!settled) {
      settled = true;
      controller.abort();
      settleSelection({ quit: true });
    }
  });

  console.log("Found floating around blue air:");
  console.log(`  scanning BR/EDR and LE for up to ${seconds}s each; results appear live`);
  rl.prompt();

  const scan = (async () => {
    for (const mode of ["bredr", "on"] as const) {
      if (controller.signal.aborted) break;
      const rows = await bluez.scanLive(mode, seconds, { signal: controller.signal, onDevice: add });
      for (const device of rows) add(device);
    }
  })();

  try {
    await Promise.race([scan, selection]);
    if (!settled) {
      await scan;
      scanFinished = true;
      printAbovePrompt(floating.size ? "Scan complete; select a device." : "Scan complete; no new devices found.");
    }
    const result = await selection;
    await scan.catch(() => {});
    return { discovered: [...floating.values()], ...result };
  } finally {
    controller.abort();
    rl.close();
  }
}

function printHostChecks(power?: AdapterPowerState, configIssues: ConfigIssue[] = []): void {
  const checks = [
    ...(power?.control === "auto" ? [`adapter ${power.vendor}:${power.product} uses USB autosuspend`] : []),
    ...configIssues.map(issue => `[${issue.section}] ${issue.key}: ${issue.message}`),
  ];
  if (!checks.length) return;
  console.log("Host checks:");
  checks.forEach((check, index) => console.log(` H${index + 1}. ${check}`));
  console.log();
}

function printSelection(device: DeviceState, notices: DeviceNotice[], registry?: DeviceRegistry): void {
  const caps = capabilities(device);
  console.log(`\nSelected: ${label(device, registry)} (${device.mac})`);
  console.log(`State: paired=${device.paired} bonded=${device.bonded ?? "unknown"} trusted=${device.trusted} connected=${device.connected}`);
  console.log(`Capabilities: ${caps.labels.join(", ") || "unknown / proprietary"}`);
  console.log(`Intents: ${caps.intents.join(", ") || "unknown"}`);
  console.log(`Profile knowledge: ${caps.recognition.recognized}/${caps.recognition.advertised} advertised UUIDs recognized${caps.composite ? " (composite device)" : ""}`);
  if (caps.unknownUuids.length) console.log(`Unknown UUIDs: ${caps.unknownUuids.join(", ")}`);
  console.log("\nChecks:");
  if (!notices.length) console.log("  No current warnings.");
  notices.forEach((notice, index) => console.log(` ${index + 1}. [${notice.severity}] ${notice.title}`));
}

function ask(query: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(query, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

export async function runDashboard(bluez: Bluez, options: {
  scanSeconds?: number;
  scan?: boolean;
  json?: boolean;
  pairTimeoutMs?: number;
  connectTimeoutMs?: number;
  bondWaitMs?: number;
} = {}): Promise<void> {
  const registry = new DeviceRegistry();
  const interactive = Boolean(process.stdin.isTTY && !options.json);
  const [cachedRows, configIssues, power] = await Promise.all([
    bluez.devices(), auditBluezConfig().catch(() => []), Promise.resolve().then(() => adapterPowerState()).catch(() => undefined),
  ]);
  
  // Record cached devices to registry to ensure they are tracked
  for (const row of cachedRows) {
    registry.record(row);
  }

  const cached = await enrich(bluez, cachedRows);
  let groups = partitionDevices(cached, []);

  if (!options.json) {
    console.log("[Blauwerk]\n");
    printHostChecks(power, configIssues);
    printDeviceList("Known devices", groups.known, 1, registry);
  }

  let selected: DeviceState | undefined;
  if (options.scan !== false) {
    const seconds = options.scanSeconds ?? 6;
    if (interactive) {
      const live = await liveDiscovery(bluez, groups.known, seconds);
      if (live.quit) return;
      selected = live.selected;
      groups = partitionDevices(cached, live.discovered);
    } else {
      const rows = [...await bluez.scan("bredr", seconds), ...await bluez.scan("on", seconds)];
      const discovered = await enrich(bluez, [...new Map(rows.map(device => [device.mac, device])).values()]);
      groups = partitionDevices(cached, discovered);
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ known: groups.known, floating: groups.floating, host: { power, configIssues } }, null, 2));
    return;
  }

  if (!interactive || options.scan === false) printDeviceList("Found floating around blue air", groups.floating, groups.known.length + 1, registry);
  const all = [...groups.known, ...groups.floating];
  if (!interactive || !all.length) return;

  if (!selected) {
    const answer = (await ask("Select device number (empty to quit): ")).trim();
    if (!answer) return;
    selected = all[Number(answer) - 1];
  }
  if (!selected) throw new Error("Invalid device selection");

  let device = await bluez.info(selected.mac);
  const audio = supportsPlayback(device) ? await new AudioManager().state(device.mac) : undefined;
  const notices = adviseDevice(device, { audio, power, configIssues });
  printSelection(device, notices, registry);

  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  const isAnonymous = !device.name || device.name === device.mac;
  if (isAnonymous) {
    probeTimer = setTimeout(() => {
      log("dashboard.lazy-probe.start", { mac: device.mac });
      bluez.connect(device.mac, undefined, 10000)
        .then(() => bluez.disconnect(device.mac))
        .then(() => bluez.info(device.mac))
        .then(freshDevice => {
          if (freshDevice.name && freshDevice.name !== freshDevice.mac) {
            registry.record(freshDevice);
            console.log(`\n\n[Blauwerk] Lazy probe resolved device identity: ${freshDevice.name} (${freshDevice.mac})`);
            device = freshDevice;
          }
        })
        .catch(() => {});
    }, 1500);
  }

  while (true) {
    const recoveryAction = device.bonded === false ? "[r]ebond" : "[r]ecover";
    const choice = (await ask(`Check number, [c]onnect, ${recoveryAction}, [a]udio, [x] disconnect, [q]uit: `)).trim().toLowerCase();
    
    if (probeTimer) {
      clearTimeout(probeTimer);
      probeTimer = undefined;
    }

    if (!choice || choice === "q") return;
    if (/^\d+$/.test(choice)) {
      const notice = notices[Number(choice) - 1];
      if (!notice) { console.log("Unknown check number."); continue; }
      console.log(`\n${notice.title}\n${notice.detail}`);
      if (notice.command) console.log(`Suggested: ${notice.command}`);
      continue;
    }
    if (choice === "x") {
      await bluez.disconnect(device.mac);
      console.log("Disconnected.");
      return;
    }
    if (choice === "a") {
      if (!device.paired) { console.log("Pair the device before recovering an audio profile."); continue; }
      console.log(Bun.inspect(await new AudioManager().ensure(bluez, device.mac), { colors: true }));
      return;
    }
    if (choice === "c" || choice === "r") {
      if (configIssues.some(issue => issue.severity === "error")) {
        console.log("Fix the listed host configuration errors first: blauwerk config --fix");
        continue;
      }
      if (choice === "r" && device.bonded === false) {
        const confirmed = (await ask("Rebond may briefly interrupt working audio. Continue? [y/N]: ")).trim().toLowerCase() === "y";
        if (!confirmed) continue;
      }
      if (!device.paired || choice === "r") {
        device = await new Recovery(bluez, {
          scanSeconds: options.scanSeconds ?? 12,
          pairTimeoutMs: options.pairTimeoutMs ?? 55_000,
          connectTimeoutMs: options.connectTimeoutMs ?? 25_000,
          bondWaitMs: options.bondWaitMs ?? 15_000,
          requireBond: choice === "r",
          allowSessionDrop: choice === "r",
        }).run(device.mac, safeMatrix);
      } else {
        if (!device.trusted) await bluez.trust(device.mac);
        if (!device.connected) await bluez.connect(device.mac);
        device = await bluez.info(device.mac);
      }
      const resultAudio = device.connected && supportsPlayback(device)
        ? await new AudioManager().ensure(bluez, device.mac) : undefined;
      device = await bluez.info(device.mac);
      const checks = adviseDevice(device, { audio: resultAudio, power, configIssues });
      console.log(Bun.inspect({
        bluetooth: device,
        capabilities: capabilities(device),
        audio: resultAudio,
        checks,
      }, { colors: true }));
      return;
    }
    console.log("Unknown action.");
  }
}
