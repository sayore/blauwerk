import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { DeviceState } from "./types";
import { capabilities } from "./catalog";

export interface RegistryDevice {
  mac: string;
  name?: string;
  alias?: string;
  class?: string;
  icon?: string;
  category: "audio" | "input" | "computer" | "phone" | "imaging" | "wearable" | "toy" | "iot" | "unknown";
  firstSeen: string;
  lastSeen: string;
  seenCount: number;
  rssiHistory: { timestamp: string; rssi: number }[];
  uuids: string[];
  capabilities: string[];
  isKnown: boolean;
}

export function classifyDevice(
  state: DeviceState,
  caps: { profiles: { label: string }[]; intents: string[] }
): RegistryDevice["category"] {
  // 1. Class of Device (CoD) parsing for Classic devices
  if (state.class) {
    const cod = parseInt(state.class, 16);
    if (!isNaN(cod)) {
      const major = (cod >> 8) & 0x1f;
      switch (major) {
        case 0x01: return "computer";
        case 0x02: return "phone";
        case 0x04: return "audio";
        case 0x05: return "input";
        case 0x06: return "imaging";
        case 0x07: return "wearable";
        case 0x08: return "toy";
        case 0x09: return "wearable"; // Health/wearable
      }
    }
  }

  // 2. Icon classification
  if (state.icon) {
    const icon = state.icon.toLowerCase();
    if (icon.includes("audio") || icon.includes("headset") || icon.includes("speaker")) return "audio";
    if (icon.includes("keyboard") || icon.includes("mouse") || icon.includes("input") || icon.includes("gamepad")) return "input";
    if (icon.includes("computer") || icon.includes("laptop")) return "computer";
    if (icon.includes("phone")) return "phone";
    if (icon.includes("camera") || icon.includes("display") || icon.includes("printer")) return "imaging";
    if (icon.includes("watch") || icon.includes("wearable")) return "wearable";
    if (icon.includes("toy")) return "toy";
  }

  // 3. UUID-based capability classification
  const uuids = state.uuids.map(u => u.toLowerCase());
  // Audio: A2DP (110b, 110d, 110c), HFP (111e, 111f), HSP (1108, 1112), LE Audio PACS (184e), BAP (184f)
  const hasAudio = uuids.some(u => 
    u.includes("110b") || u.includes("110d") || u.includes("110c") || 
    u.includes("111e") || u.includes("111f") || u.includes("1108") || 
    u.includes("1112") || u.includes("184e") || u.includes("184f") ||
    caps.intents.includes("music") || caps.intents.includes("calls")
  );
  if (hasAudio) return "audio";

  // Input: Classic HID (1124), HOGP (1812)
  const hasInput = uuids.some(u => u.includes("1124") || u.includes("1812") || caps.intents.includes("input"));
  if (hasInput) return "input";

  // Wearable/Health: Heart Rate (180d), Cycling (1816), GATT Watch (112d etc)
  const hasWearable = uuids.some(u => u.includes("180d") || u.includes("1816") || u.includes("183e") || caps.intents.includes("wearable") || caps.intents.includes("sensors"));
  if (hasWearable) return "wearable";

  // Phone/Network
  if (caps.intents.includes("networking")) return "iot";

  // 4. Name-based heuristics fallback
  const name = (state.name || state.alias || "").toLowerCase();
  if (name) {
    if (name.includes("speaker") || name.includes("headset") || name.includes("headphones") || name.includes("earbuds") || name.includes("boom") || name.includes("audio") || name.includes("sound")) {
      return "audio";
    }
    if (name.includes("keyboard") || name.includes("mouse") || name.includes("gamepad") || name.includes("controller") || name.includes("pointer")) {
      return "input";
    }
    if (name.includes("tv") || name.includes("television") || name.includes("display") || name.includes("screen")) {
      return "imaging";
    }
    if (name.includes("watch") || name.includes("fitbit") || name.includes("band") || name.includes("tracker")) {
      return "wearable";
    }
    if (name.includes("toy") || name.includes("robot") || name.includes("car")) {
      return "toy";
    }
  }

  return "unknown";
}

export class DeviceRegistry {
  private devices = new Map<string, RegistryDevice>();
  private readonly path: string;

  constructor(customPath?: string) {
    const home = homedir() || process.env.HOME || tmpdir();
    this.path = customPath || join(home, ".cache", "blauwerk", "registry.json");
    this.load();
  }

  load(): void {
    if (!existsSync(this.path)) {
      this.devices.clear();
      return;
    }
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8"));
      this.devices.clear();
      if (Array.isArray(data)) {
        for (const dev of data) {
          if (dev.mac) this.devices.set(dev.mac, dev);
        }
      }
    } catch {
      // Best effort fallback
      this.devices.clear();
    }
  }

  save(): void {
    try {
      const dir = dirname(this.path);
      mkdirSync(dir, { recursive: true });
      const data = JSON.stringify(this.list(), null, 2);
      const tmpPath = `${this.path}.tmp`;
      writeFileSync(tmpPath, data, { encoding: "utf8", mode: 0o600 });
      renameSync(tmpPath, this.path);
    } catch {
      // Ignore write errors (best effort persistent cache)
    }
  }

  list(): RegistryDevice[] {
    return Array.from(this.devices.values());
  }

  get(mac: string): RegistryDevice | undefined {
    return this.devices.get(mac);
  }

  record(state: DeviceState): RegistryDevice {
    const now = new Date().toISOString();
    const existing = this.devices.get(state.mac);
    const caps = capabilities(state);

    const name = state.name || existing?.name;
    const alias = state.alias || existing?.alias;
    const devClass = state.class || existing?.class;
    const icon = state.icon || existing?.icon;

    // Merge UUID lists uniquely
    const uuids = Array.from(new Set([...(state.uuids || []), ...(existing?.uuids || [])]));
    const labels = caps.profiles.map(p => p.label);
    const existingCaps = existing?.capabilities || [];
    const mergedCaps = Array.from(new Set([...labels, ...existingCaps]));

    const category = classifyDevice(state, caps);

    // Maintain a capped RSSI history (last 10 entries)
    const rssiHistory = existing?.rssiHistory ? [...existing.rssiHistory] : [];
    if (state.rssi !== undefined) {
      rssiHistory.push({ timestamp: now, rssi: state.rssi });
      if (rssiHistory.length > 10) rssiHistory.shift();
    }

    const device: RegistryDevice = {
      mac: state.mac,
      name,
      alias,
      class: devClass,
      icon,
      category: category !== "unknown" ? category : (existing?.category ?? "unknown"),
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
      seenCount: (existing?.seenCount ?? 0) + 1,
      rssiHistory,
      uuids,
      capabilities: mergedCaps,
      isKnown: state.paired || state.trusted || Boolean(existing?.isKnown),
    };

    this.devices.set(state.mac, device);
    this.save();
    return device;
  }
}
