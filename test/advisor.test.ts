import { describe, expect, test } from "bun:test";
import { adviseDevice } from "../src/advisor";
import type { DeviceState } from "../src/types";

const device = (overrides: Partial<DeviceState> = {}): DeviceState => ({
  mac: "AA:BB:CC:DD:EE:FF", available: true, paired: true, bonded: true,
  trusted: true, blocked: false, connected: false, uuids: [], raw: "", ...overrides,
});

describe("device advisor", () => {
  test("reports actionable bond and power settings", () => {
    const notices = adviseDevice(device({ bonded: false }), {
      power: { path: "/sys/device", control: "auto", autosuspendDelayMs: 2_000 },
    });
    expect(notices.map(notice => notice.id)).toContain("not-bonded");
    expect(notices.map(notice => notice.id)).toContain("adapter-autosuspend");
    expect(notices.every(notice => notice.detail.length > 0)).toBeTrue();
  });

  test("reports a missing audio card only for an audio device", () => {
    const notices = adviseDevice(device({ connected: true, uuids: ["Audio Sink (0000110b-0000-1000-8000-00805f9b34fb)"] }), {
      audio: { serverAvailable: true, cardFound: false, sinkFound: false, availableProfiles: [] },
    });
    expect(notices.map(notice => notice.id)).toContain("audio-card-missing");
  });

  test("explains that discovery-time capabilities may be incomplete", () => {
    const notices = adviseDevice(device({ paired: false, bonded: false, uuids: ["Vendor (12345678-1234-5678-1234-567812345678)"] }));
    expect(notices.map(notice => notice.id)).toContain("capabilities-pending");
  });

  test("warns about moderate to poor signal RF/USB 3.0 interference", () => {
    const notices = adviseDevice(device({ rssi: -78 }));
    expect(notices.map(notice => notice.id)).toContain("rf-interference");
  });

  test("warns when LE Audio PACS is present but BAP is missing", () => {
    const notices = adviseDevice(device({ uuids: ["00001850-0000-1000-8000-00805f9b34fb"] })); // PACS only
    expect(notices.map(notice => notice.id)).toContain("le-audio-bap-missing");
  });

  test("warns when audio headset supports music but has no call/microphone UUIDs", () => {
    const notices = adviseDevice(device({ uuids: ["0000110b-0000-1000-8000-00805f9b34fb"] })); // Audio Sink (A2DP)
    expect(notices.map(notice => notice.id)).toContain("headset-no-microphone");
  });

  test("warns when HFP backend is missing in WirePlumber", () => {
    const notices = adviseDevice(
      device({ connected: true, uuids: ["0000110b-0000-1000-8000-00805f9b34fb", "0000111e-0000-1000-8000-00805f9b34fb"] }), // Sink + Handsfree
      { audio: { serverAvailable: true, cardFound: true, sinkFound: true, availableProfiles: ["a2dp-sink"] } } // lacks headset profile
    );
    expect(notices.map(notice => notice.id)).toContain("hfp-backend-missing");
  });

  test("notifies when a paired gamepad is disconnected", () => {
    const notices = adviseDevice(device({ connected: false, paired: true, uuids: ["00001124-0000-1000-8000-00805f9b34fb"] })); // HID profile
    expect(notices.map(notice => notice.id)).toContain("gamepad-idle-sleep");
  });
});
