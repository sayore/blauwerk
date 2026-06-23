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
}

const has = (state: DeviceState, uuid: string) => state.uuids.some(value => value.toLowerCase().includes(uuid));

export function capabilities(state: DeviceState): Capabilities {
  const result = {
    audioSink: has(state, "0000110b"), audioSource: has(state, "0000110a"),
    mediaControl: has(state, "0000110c") || has(state, "0000110e"),
    handsFree: has(state, "0000111e") || has(state, "0000111f"),
    headset: has(state, "00001108") || has(state, "00001112"),
    humanInterface: has(state, "00001124"), network: has(state, "00001115") || has(state, "00001116"),
    labels: [] as string[],
  };
  if (result.audioSink) result.labels.push("A2DP sink");
  if (result.audioSource) result.labels.push("A2DP source");
  if (result.mediaControl) result.labels.push("AVRCP");
  if (result.handsFree) result.labels.push("hands-free");
  if (result.headset) result.labels.push("headset");
  if (result.humanInterface) result.labels.push("HID");
  if (result.network) result.labels.push("network");
  return result;
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
    return Promise.all([...unique.keys()].map(mac => this.backend.info(mac)));
  }

  async inspect(mac: string): Promise<{ device: DeviceState; capabilities: Capabilities }> {
    const device = await this.backend.info(mac);
    return { device, capabilities: capabilities(device) };
  }
}
