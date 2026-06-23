import { describe, expect, test } from "bun:test";
import { parseDeviceSelection, partitionDevices, supportsPlayback } from "../src/dashboard";
import type { DeviceState } from "../src/types";

const device = (mac: string, overrides: Partial<DeviceState> = {}): DeviceState => ({
  mac, available: true, paired: false, trusted: false, blocked: false,
  connected: false, uuids: [], raw: "", ...overrides,
});

describe("dashboard grouping", () => {
  test("separates known state from newly discovered devices", () => {
    const known = device("AA:AA:AA:AA:AA:AA", { paired: true });
    const floating = device("BB:BB:BB:BB:BB:BB");
    const groups = partitionDevices([known], [known, floating, floating]);
    expect(groups.known.map(item => item.mac)).toEqual([known.mac]);
    expect(groups.floating.map(item => item.mac)).toEqual([floating.mac]);
  });

  test("re-evaluates playback support from the current UUID set", () => {
    const discovered = device("CC:CC:CC:CC:CC:CC", {
      uuids: ["Vendor specific (00000000-deca-fade-deca-deafdecacaff)"],
    });
    expect(supportsPlayback(discovered)).toBeFalse();
    expect(supportsPlayback({
      ...discovered,
      paired: true,
      uuids: [...discovered.uuids, "Audio Sink (0000110b-0000-1000-8000-00805f9b34fb)"],
    })).toBeTrue();
  });

  test("accepts device numbers with a check badge suffix", () => {
    expect(parseDeviceSelection("1")).toBe(0);
    expect(parseDeviceSelection("1 setting")).toBe(0);
    expect(parseDeviceSelection("2 checks")).toBe(1);
    expect(parseDeviceSelection("Tribit")).toBeUndefined();
  });
});
