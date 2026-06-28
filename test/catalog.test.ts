import { describe, expect, test } from "bun:test";
import { capabilities, DeviceCatalog, mergeDuplicateIdentities, selectBearerForIntent } from "../src/catalog";
import type { DeviceState } from "../src/types";

describe("capability abstraction", () => {
  test("classifies common Bluetooth audio UUIDs", () => {
    const device: DeviceState = {
      mac: "AC:B1:EE:71:A1:51", available: true, paired: false, trusted: false,
      blocked: false, connected: false, uuids: [
        "Audio Sink (0000110b-0000-1000-8000-00805f9b34fb)",
        "A/V Remote Control (0000110e-0000-1000-8000-00805f9b34fb)",
      ], raw: "",
    };
    expect(capabilities(device).labels).toEqual(["A2DP sink", "AVRCP"]);
  });

  test("reports intents, composite devices and unknown services", () => {
    const device: DeviceState = {
      mac: "AA:BB:CC:DD:EE:FF", available: true, paired: true, trusted: true,
      blocked: false, connected: true, uuids: [
        "Audio Sink (0000110b-0000-1000-8000-00805f9b34fb)",
        "Human Interface Device (00001124-0000-1000-8000-00805f9b34fb)",
        "Battery Service (0000180f-0000-1000-8000-00805f9b34fb)",
        "Vendor Service (12345678-1234-5678-1234-567812345678)",
      ], raw: "",
    };
    const report = capabilities(device);
    expect(report.intents).toEqual(["music-playback", "input", "battery"]);
    expect(report.composite).toBeTrue();
    expect(report.recognition).toEqual({ advertised: 4, recognized: 3, ratio: 0.75 });
    expect(report.unknownUuids).toEqual(["12345678-1234-5678-1234-567812345678"]);
  });
  test("merges duplicate Classic and LE identities", () => {
    const devices: DeviceState[] = [
      {
        mac: "11:22:33:44:55:66", name: "Tribit Speaker", available: true, paired: true, trusted: true,
        blocked: false, connected: true, addressType: "public", uuids: ["0000110b-0000-1000-8000-00805f9b34fb"], raw: "",
      },
      {
        mac: "11:22:33:44:55:67", name: "Tribit Speaker", available: true, paired: false, trusted: false,
        blocked: false, connected: false, addressType: "random", uuids: ["0000180f-0000-1000-8000-00805f9b34fb"], raw: "",
      }
    ];
    const merged = mergeDuplicateIdentities(devices);
    expect(merged.length).toBe(1);
    const firstMerged = merged[0];
    expect(firstMerged).toBeDefined();
    if (firstMerged) {
      expect(firstMerged.mac).toBe("11:22:33:44:55:66");
      expect(firstMerged.paired).toBeTrue();
      expect(firstMerged.uuids).toContain("0000110b-0000-1000-8000-00805f9b34fb");
      expect(firstMerged.uuids).toContain("0000180f-0000-1000-8000-00805f9b34fb");
    }
  });

  test("keeps anonymous devices while merging named duplicate identities", () => {
    const anonymous: DeviceState = {
      mac: "AA:00:00:00:00:01", available: true, paired: false, trusted: false,
      blocked: false, connected: false, uuids: [], raw: "",
    };
    const named: DeviceState = {
      mac: "AA:00:00:00:00:02", name: "Named Device", available: true, paired: false, trusted: false,
      blocked: false, connected: false, uuids: [], raw: "",
    };

    expect(mergeDuplicateIdentities([anonymous, named]).map(device => device.mac)).toEqual([anonymous.mac, named.mac]);
  });

  test("catalog list falls back to scan data if a device disappears before info lookup", async () => {
    const fallback: DeviceState = {
      mac: "AA:00:00:00:00:03", available: true, paired: false, trusted: false,
      blocked: false, connected: false, uuids: [], raw: "",
    };
    const catalog = new DeviceCatalog({
      devices: async () => [],
      scan: async () => [fallback],
      info: async () => {
        throw new Error("not available");
      },
      trust: async () => {},
      connect: async () => {},
      disconnect: async () => {},
    });

    expect((await catalog.list({ scan: true })).map(device => device.mac)).toEqual([fallback.mac]);
  });

  test("resolves correct bearer for intent", () => {
    expect(selectBearerForIntent({} as any, "music-playback")).toBe("bredr");
    expect(selectBearerForIntent({} as any, "sensor")).toBe("le");
    expect(selectBearerForIntent({} as any, "file-transfer")).toBe("any");
  });

  describe("profile registry conformity", () => {
    const keys = [
      "1101", "1103", "1105", "1106", "1108", "110a", "110b", "110c",
      "110d", "110e", "1112", "1115", "1116", "1117", "111e", "111f",
      "1124", "112e", "112f", "1132", "1133", "1134", "1200", "1800",
      "1801", "180f", "1812", "184e", "184f", "1850", "1851", "1853",
      "1854", "1855", "1856", "03b80e5a-ede8-4b33-a751-6ce34ec4c700"
    ];

    for (const key of keys) {
      test(`verifies capability mapping for UUID suffix/hash ${key}`, () => {
        const fullUuid = key.length === 4 ? `0000${key}-0000-1000-8000-00805f9b34fb` : key;
        const device: DeviceState = {
          mac: "AA:BB:CC:DD:EE:FF", available: true, paired: false, trusted: false,
          blocked: false, connected: false, uuids: [fullUuid], raw: "",
        };
        const caps = capabilities(device);
        expect(caps.profiles.length).toBe(1);
        expect(caps.profiles[0]?.uuid).toBe(key);
        expect(caps.recognition.recognized).toBe(1);
      });
    }
  });
});
