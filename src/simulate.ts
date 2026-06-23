import type { Bluez } from "./bluez";
import { Recovery, safeMatrix } from "./matrix";
import type { DeviceState, RunResult } from "./types";
import { capabilities } from "./catalog";

const MOCK_MAC = "AA:BB:CC:DD:EE:FF";

function createDevice(overrides: Partial<DeviceState> = {}): DeviceState {
  return {
    mac: MOCK_MAC,
    available: true,
    name: "Simulated Headset",
    alias: "Simulated Headset",
    paired: false,
    bonded: false,
    trusted: false,
    blocked: false,
    connected: false,
    servicesResolved: false,
    rssi: -60,
    uuids: ["0000110b-0000-1000-8000-00805f9b34fb"], // Audio Sink (A2DP)
    raw: "",
    ...overrides,
  };
}

export async function runSimulation(type: string): Promise<void> {
  console.log(`\n=== Running Simulation: ${type} ===`);
  console.log(`Target Mock Device: ${MOCK_MAC} (Simulated Headset)`);

  let currentDeviceState = createDevice();
  let step = 0;

  // Implement Mock BlueZ interface
  const mockBluez = {
    dryRun: false,
    assertReady: async () => {},
    prepare: async () => {
      console.log(`[mock.prepare] Initializing controller...`);
    },
    resolveAdapter: async () => {},
    devices: async () => [currentDeviceState],
    info: async (mac: string) => {
      if (mac !== MOCK_MAC) throw new Error("Device not found");
      return currentDeviceState;
    },
    scanLive: async (_mode: string, _seconds: number, options?: { onSeen?: (mac: string) => void }) => {
      console.log(`[mock.scan] Scanning for device...`);
      await Bun.sleep(500);
      if (type === "multipoint-conflict" || type === "stale-link-key" || type === "pairing-agent") {
        console.log(`[mock.scan] Device found advertising!`);
        options?.onSeen?.(MOCK_MAC);
        return [currentDeviceState];
      }
      return [];
    },
    trust: async (mac: string) => {
      console.log(`[mock.trust] Trusting device ${mac}`);
      currentDeviceState.trusted = true;
    },
    untrust: async (mac: string) => {
      console.log(`[mock.untrust] Untrusting device ${mac}`);
      currentDeviceState.trusted = false;
    },
    disconnect: async (mac: string) => {
      console.log(`[mock.disconnect] Disconnecting ${mac}`);
      currentDeviceState.connected = false;
    },
    remove: async (mac: string) => {
      console.log(`[mock.remove] Removing bond state for ${mac} from host cache`);
      currentDeviceState.paired = false;
      currentDeviceState.bonded = false;
    },
    pair: async (mac: string): Promise<RunResult> => {
      step++;
      console.log(`[mock.pair] Initiating pairing (Attempt ${step})...`);
      await Bun.sleep(800);

      if (type === "stale-link-key" && step < 3) {
        // First two attempts simulate stale link key failures before host-side bond removal
        console.log(`[mock.pair] Connection failed (remote rejected pair link with outdated key)`);
        throw new Error("org.bluez.Error.Failed: Connection Failed");
      }

      if (type === "pairing-agent") {
        // Simulates prompt loop for numeric confirmation
        console.log(`\n[agent] Confirm display key 123456 (yes/no):`);
        const confirm = prompt("Type 'yes' to simulate user action: ")?.trim().toLowerCase();
        if (confirm !== "yes") {
          console.log(`[mock.pair] User rejected pairing confirmation`);
          throw new Error("org.bluez.Error.Rejected: Rejected");
        }
      }

      // Success path
      currentDeviceState.paired = true;
      currentDeviceState.bonded = true;
      console.log(`[mock.pair] Pairing successful!`);
      return { argv: [], exitCode: 0, stdout: "Pairing successful", stderr: "", timedOut: false };
    },
    connect: async (mac: string): Promise<void> => {
      console.log(`[mock.connect] Connecting to profile layer...`);
      await Bun.sleep(800);

      if (type === "multipoint-conflict") {
        console.log(`[mock.connect] Connection failed: Host is down (Page Timeout)`);
        throw new Error("org.bluez.Error.Failed: Host is down");
      }

      currentDeviceState.connected = true;
      currentDeviceState.servicesResolved = true;
      console.log(`[mock.connect] Connection established successfully!`);
    },
    cancelPairing: async () => {},
  } as unknown as Bluez;

  const recovery = new Recovery(mockBluez, {
    scanSeconds: 1,
    pairTimeoutMs: 1000,
    connectTimeoutMs: 1000,
    bondWaitMs: 1000,
    requireBond: true,
  });

  try {
    const finalState = await recovery.run(MOCK_MAC, safeMatrix);
    console.log(`\n=== Simulation Finished ===`);
    console.log(`Result: Connected = ${finalState.connected}, Paired = ${finalState.paired}, Bonded = ${finalState.bonded}`);
    if (finalState.connected && finalState.paired) {
      console.log("STATUS: SUCCESS. Device recovered successfully!");
    } else {
      console.log("STATUS: INCOMPLETE. Recovery reached guidance limit.");
    }
  } catch (error) {
    console.error(`\n=== Simulation Terminated with Error ===`);
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  }
}
