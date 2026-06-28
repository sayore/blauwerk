import { capabilities } from "./catalog";
import type { RegistryDevice } from "./registry";
import type { AudioState, DeviceState } from "./types";

type OwnedCategory = "all" | "audio" | "input";

export interface OwnedConnectResult {
  mac: string;
  name?: string;
  category: OwnedCategory | "unknown";
  attempted: boolean;
  connected: boolean;
  alreadyConnected: boolean;
  audio?: AudioState;
  skipped?: string;
  error?: string;
}

interface OwnedBluez {
  devices(): Promise<DeviceState[]>;
  info(mac: string): Promise<DeviceState>;
  trust(mac: string): Promise<void>;
  connect(mac: string, profile?: string, timeoutMs?: number): Promise<void>;
  unblock?(mac: string): Promise<void>;
}

interface OwnedAudioManager {
  ensure(bluez: unknown, mac: string): Promise<AudioState>;
}

interface OwnedRegistry {
  list(): RegistryDevice[];
}

function isOwned(state: DeviceState | undefined, registry?: RegistryDevice): boolean {
  return Boolean(state?.paired || state?.trusted || state?.bonded || registry?.isKnown);
}

function inferredCategory(state: DeviceState | undefined, registry?: RegistryDevice): OwnedConnectResult["category"] {
  if (registry?.category && registry.category !== "unknown") return registry.category === "audio" || registry.category === "input" ? registry.category : "unknown";
  if (!state) return "unknown";
  const caps = capabilities(state);
  if (caps.audioSink || caps.audioSource || caps.handsFree || caps.headset) return "audio";
  if (caps.humanInterface) return "input";
  return "unknown";
}

function matchesCategory(category: OwnedCategory, state: DeviceState | undefined, registry?: RegistryDevice): boolean {
  if (category === "all") return true;
  return inferredCategory(state, registry) === category;
}

function displayName(state: DeviceState | undefined, registry?: RegistryDevice): string | undefined {
  return state?.alias ?? state?.name ?? registry?.alias ?? registry?.name;
}

export async function connectOwnedDevices(
  bluez: OwnedBluez,
  options: {
    registry?: OwnedRegistry;
    category?: OwnedCategory;
    audioFix?: boolean;
    audioManager?: OwnedAudioManager;
    connectTimeoutMs?: number;
  } = {},
): Promise<OwnedConnectResult[]> {
  const category = options.category ?? "all";
  const registryByMac = new Map((options.registry?.list() ?? []).map(device => [device.mac, device]));
  const candidates = new Map<string, DeviceState | undefined>();

  for (const device of await bluez.devices()) candidates.set(device.mac, device);
  for (const device of registryByMac.values()) {
    if (device.isKnown && !candidates.has(device.mac)) candidates.set(device.mac, undefined);
  }

  const results: OwnedConnectResult[] = [];
  for (const [mac, cached] of candidates) {
    const registryDevice = registryByMac.get(mac);
    let state = await bluez.info(mac).catch(() => cached);
    const resultBase = {
      mac,
      name: displayName(state, registryDevice),
      category: inferredCategory(state, registryDevice),
    };

    if (!isOwned(state, registryDevice)) {
      results.push({ ...resultBase, attempted: false, connected: Boolean(state?.connected), alreadyConnected: Boolean(state?.connected), skipped: "not-owned" });
      continue;
    }
    if (!matchesCategory(category, state, registryDevice)) {
      results.push({ ...resultBase, attempted: false, connected: Boolean(state?.connected), alreadyConnected: Boolean(state?.connected), skipped: `category-${category}` });
      continue;
    }

    const alreadyConnected = Boolean(state?.connected);
    try {
      if (state?.blocked && bluez.unblock) {
        await bluez.unblock(mac);
        state = await bluez.info(mac);
      }
      if (state?.paired && !state.trusted) {
        await bluez.trust(mac);
        state = await bluez.info(mac);
      }
      if (!state?.connected) {
        await bluez.connect(mac, undefined, options.connectTimeoutMs);
        state = await bluez.info(mac);
      }

      let audio: AudioState | undefined;
      if (options.audioFix && state.connected && capabilities(state).audioSink && options.audioManager) {
        audio = await options.audioManager.ensure(bluez, mac);
      }
      results.push({
        ...resultBase,
        category: inferredCategory(state, registryDevice),
        attempted: true,
        connected: state.connected,
        alreadyConnected,
        audio,
        error: state.connected ? undefined : "not connected after connect attempt",
      });
    } catch (error) {
      const latest = await bluez.info(mac).catch(() => state);
      results.push({
        ...resultBase,
        category: inferredCategory(latest, registryDevice),
        attempted: true,
        connected: Boolean(latest?.connected),
        alreadyConnected,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}
