export type Agent = "NoInputNoOutput" | "DisplayYesNo" | "KeyboardDisplay";
export type ScanMode = "bredr" | "le" | "on";

export interface DeviceState {
  mac: string;
  available: boolean;
  addressType?: "public" | "random" | string;
  name?: string;
  alias?: string;
  icon?: string;
  class?: string;
  legacyPairing?: boolean;
  paired: boolean;
  bonded?: boolean;
  trusted: boolean;
  blocked: boolean;
  connected: boolean;
  servicesResolved?: boolean;
  rssi?: number;
  uuids: string[];
  raw: string;
}

export interface Attempt {
  agent: Agent;
  scan: ScanMode;
  reset: "none" | "remove" | "purge" | "restart" | "powercycle";
}

export interface RunResult {
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface AudioState {
  serverAvailable: boolean;
  cardFound: boolean;
  sinkFound: boolean;
  cardName?: string;
  sinkName?: string;
  activeProfile?: string;
  availableProfiles: string[];
  bluetoothConnected?: boolean;
  targetSeen?: boolean;
  error?: string;
}
