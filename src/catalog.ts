import type { BluetoothBackend } from "./backend";
import type { DeviceState } from "./types";

export interface Capabilities {
  audioSink: boolean;
  audioSource: boolean;
  mediaControl: boolean;
  handsFree: boolean;
  headset: boolean;
  humanInterface: boolean;
  network: boolean;
  labels: string[];
  profiles: ProfileCapability[];
  domains: CapabilityDomain[];
  intents: DeviceIntent[];
  unknownUuids: string[];
  composite: boolean;
  recognition: {
    advertised: number;
    recognized: number;
    ratio: number;
  };
}

export type CapabilityDomain = "audio" | "media" | "input" | "network" | "data" | "telephony" | "sensor" | "midi" | "identity";
export type DeviceIntent =
  | "music-playback"
  | "music-source"
  | "media-control"
  | "calls"
  | "input"
  | "network"
  | "serial-data"
  | "file-transfer"
  | "contacts"
  | "messages"
  | "sensor"
  | "midi"
  | "le-audio"
  | "battery";

export interface ProfileCapability {
  id: string;
  uuid: string;
  label: string;
  domain: CapabilityDomain;
  intent?: DeviceIntent;
  direction?: "source" | "sink" | "client" | "server" | "controller" | "target" | "bidirectional";
}

const profileRegistry: Record<string, Omit<ProfileCapability, "uuid">> = {
  "1101": { id: "spp", label: "Serial Port", domain: "data", intent: "serial-data", direction: "bidirectional" },
  "1103": { id: "dun", label: "Dial-up Networking", domain: "network", intent: "network", direction: "bidirectional" },
  "1105": { id: "opp", label: "Object Push", domain: "data", intent: "file-transfer", direction: "bidirectional" },
  "1106": { id: "ftp", label: "File Transfer", domain: "data", intent: "file-transfer", direction: "bidirectional" },
  "1108": { id: "hsp-hs", label: "Headset", domain: "telephony", intent: "calls", direction: "client" },
  "110a": { id: "a2dp-source", label: "A2DP source", domain: "audio", intent: "music-source", direction: "source" },
  "110b": { id: "a2dp-sink", label: "A2DP sink", domain: "audio", intent: "music-playback", direction: "sink" },
  "110c": { id: "avrcp-target", label: "AVRCP target", domain: "media", intent: "media-control", direction: "target" },
  "110d": { id: "a2dp", label: "Advanced Audio Distribution", domain: "audio" },
  "110e": { id: "avrcp-controller", label: "AVRCP controller", domain: "media", intent: "media-control", direction: "controller" },
  "1112": { id: "hsp-ag", label: "Headset audio gateway", domain: "telephony", intent: "calls", direction: "server" },
  "1115": { id: "panu", label: "PAN user", domain: "network", intent: "network", direction: "client" },
  "1116": { id: "nap", label: "Network access point", domain: "network", intent: "network", direction: "server" },
  "1117": { id: "gn", label: "Group network", domain: "network", intent: "network", direction: "server" },
  "111e": { id: "hfp-hf", label: "Hands-free", domain: "telephony", intent: "calls", direction: "client" },
  "111f": { id: "hfp-ag", label: "Hands-free audio gateway", domain: "telephony", intent: "calls", direction: "server" },
  "1124": { id: "hid", label: "Human Interface Device", domain: "input", intent: "input", direction: "client" },
  "112e": { id: "pbap-client", label: "Phone Book Access client", domain: "data", intent: "contacts", direction: "client" },
  "112f": { id: "pbap-server", label: "Phone Book Access server", domain: "data", intent: "contacts", direction: "server" },
  "1132": { id: "map-server", label: "Message Access server", domain: "data", intent: "messages", direction: "server" },
  "1133": { id: "map-notification", label: "Message notification server", domain: "data", intent: "messages", direction: "server" },
  "1134": { id: "map-client", label: "Message Access client", domain: "data", intent: "messages", direction: "client" },
  "1200": { id: "pnp", label: "PnP Information", domain: "identity" },
  "1800": { id: "gap", label: "Generic Access", domain: "identity" },
  "1801": { id: "gatt", label: "Generic Attribute", domain: "sensor", intent: "sensor" },
  "180f": { id: "battery", label: "Battery Service", domain: "sensor", intent: "battery" },
  "1812": { id: "hogp", label: "HID over GATT", domain: "input", intent: "input", direction: "client" },
  "184e": { id: "ascs", label: "LE Audio Stream Control", domain: "audio", intent: "le-audio" },
  "184f": { id: "bass", label: "Broadcast Audio Scan", domain: "audio", intent: "le-audio" },
  "1850": { id: "pacs", label: "Published Audio Capabilities", domain: "audio", intent: "le-audio" },
  "1851": { id: "baas", label: "Basic Audio Announcement", domain: "audio", intent: "le-audio" },
  "1853": { id: "cas", label: "Common Audio", domain: "audio", intent: "le-audio" },
  "1854": { id: "has", label: "Hearing Access", domain: "audio", intent: "le-audio" },
  "1855": { id: "tmas", label: "Telephony and Media Audio", domain: "audio", intent: "le-audio" },
  "1856": { id: "pba", label: "Public Broadcast Announcement", domain: "audio", intent: "le-audio" },
  "03b80e5a-ede8-4b33-a751-6ce34ec4c700": { id: "ble-midi", label: "BLE MIDI", domain: "midi", intent: "midi", direction: "bidirectional" },
};

function uuidOf(value: string): string | undefined {
  const full = value.toLowerCase().match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
  if (!full) return undefined;
  return full.startsWith("0000") && full.endsWith("-0000-1000-8000-00805f9b34fb") ? full.slice(4, 8) : full;
}

const hasProfile = (profiles: ProfileCapability[], id: string) => profiles.some(profile => profile.id === id);

export function capabilities(state: DeviceState): Capabilities {
  const advertised = [...new Set(state.uuids.map(uuidOf).filter((uuid): uuid is string => Boolean(uuid)))];
  const profiles = advertised.flatMap(uuid => {
    const profile = profileRegistry[uuid];
    return profile ? [{ ...profile, uuid }] : [];
  });
  const unknownUuids = advertised.filter(uuid => !profileRegistry[uuid]);
  const result = {
    audioSink: hasProfile(profiles, "a2dp-sink"), audioSource: hasProfile(profiles, "a2dp-source"),
    mediaControl: profiles.some(profile => profile.id.startsWith("avrcp-")),
    handsFree: profiles.some(profile => profile.id.startsWith("hfp-")),
    headset: profiles.some(profile => profile.id.startsWith("hsp-")),
    humanInterface: hasProfile(profiles, "hid") || hasProfile(profiles, "hogp"),
    network: profiles.some(profile => ["panu", "nap", "gn", "dun"].includes(profile.id)),
    labels: [] as string[],
    profiles,
    domains: [...new Set(profiles.map(profile => profile.domain))],
    intents: [...new Set(profiles.flatMap(profile => profile.intent ? [profile.intent] : []))],
    unknownUuids,
    composite: false,
    recognition: {
      advertised: advertised.length,
      recognized: profiles.length,
      ratio: advertised.length ? profiles.length / advertised.length : 0,
    },
  };
  if (result.audioSink) result.labels.push("A2DP sink");
  if (result.audioSource) result.labels.push("A2DP source");
  if (result.mediaControl) result.labels.push("AVRCP");
  if (result.handsFree) result.labels.push("hands-free");
  if (result.headset) result.labels.push("headset");
  if (result.humanInterface) result.labels.push("HID");
  if (result.network) result.labels.push("network");
  result.composite = result.domains.filter(domain => !["identity", "media"].includes(domain)).length > 1;
  return result;
}

export function mergeDuplicateIdentities(devices: DeviceState[]): DeviceState[] {
  const merged: DeviceState[] = [];
  const seenNames = new Map<string, DeviceState>();
  for (const device of devices) {
    const nameKey = device.name?.toLowerCase() || device.alias?.toLowerCase();
    if (!nameKey) {
      merged.push(device);
      continue;
    }
    const existing = seenNames.get(nameKey);
    if (existing) {
      const keepClassic = existing.addressType === "random" && device.addressType !== "random";
      const keepPaired = !existing.paired && device.paired;
      const preferDevice = keepClassic || keepPaired ? device : existing;
      const discardDevice = preferDevice === existing ? device : existing;

      preferDevice.uuids = [...new Set([...preferDevice.uuids, ...discardDevice.uuids])];
      if (discardDevice.connected) preferDevice.connected = true;
      if (discardDevice.paired) preferDevice.paired = true;
      if (discardDevice.bonded) preferDevice.bonded = true;
      if (discardDevice.trusted) preferDevice.trusted = true;

      seenNames.set(nameKey, preferDevice);
    } else {
      seenNames.set(nameKey, device);
    }
  }
  return [...merged, ...seenNames.values()];
}

export function selectBearerForIntent(device: DeviceState, intent: DeviceIntent): "bredr" | "le" | "any" {
  if (["music-playback", "music-source", "calls", "media-control"].includes(intent)) {
    return "bredr";
  }
  if (["sensor", "le-audio", "battery"].includes(intent)) {
    return "le";
  }
  return "any";
}

export class DeviceCatalog {
  constructor(private readonly backend: BluetoothBackend) {}

  async list(options: { scan?: boolean; seconds?: number } = {}): Promise<DeviceState[]> {
    let devices = await this.backend.devices();
    if (options.scan) {
      const bredr = await this.backend.scan("bredr", options.seconds ?? 8);
      const all = await this.backend.scan("on", options.seconds ?? 8);
      devices = [...devices, ...bredr, ...all];
    }
    const unique = new Map(devices.map(device => [device.mac, device]));
    const states = await Promise.all([...unique.entries()].map(([mac, fallback]) => this.backend.info(mac).catch(() => fallback)));
    return mergeDuplicateIdentities(states);
  }

  async inspect(mac: string): Promise<{ device: DeviceState; capabilities: Capabilities }> {
    const device = await this.backend.info(mac);
    return { device, capabilities: capabilities(device) };
  }
}
