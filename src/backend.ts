import type { DeviceState, ScanMode } from "./types";

/** Platform boundary. A future macOS/Windows backend implements this contract. */
export interface BluetoothBackend {
  devices(): Promise<DeviceState[]>;
  scan(mode: ScanMode, seconds: number): Promise<DeviceState[]>;
  info(mac: string): Promise<DeviceState>;
  trust(mac: string): Promise<void>;
  connect(mac: string, profile?: string, timeoutMs?: number): Promise<void>;
  disconnect(mac: string): Promise<void>;
}
