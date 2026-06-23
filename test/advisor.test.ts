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
});
