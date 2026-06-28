import { describe, expect, test } from "bun:test";
import { connectOwnedDevices } from "../src/owned";
import type { DeviceState } from "../src/types";

const device = (mac: string, overrides: Partial<DeviceState> = {}): DeviceState => ({
  mac,
  available: true,
  paired: false,
  trusted: false,
  blocked: false,
  connected: false,
  uuids: [],
  raw: "",
  ...overrides,
});

describe("connect owned devices", () => {
  test("connects paired or trusted devices and skips unknown devices", async () => {
    const known = device("AA:AA:AA:AA:AA:AA", { paired: true, trusted: true });
    const unknown = device("BB:BB:BB:BB:BB:BB");
    let connected = false;
    const bluez = {
      devices: async () => [known, unknown],
      info: async (mac: string) => mac === known.mac ? { ...known, connected } : unknown,
      trust: async () => {},
      connect: async () => { connected = true; },
    };

    const results = await connectOwnedDevices(bluez);
    expect(results.find(result => result.mac === known.mac)?.connected).toBeTrue();
    expect(results.find(result => result.mac === unknown.mac)?.skipped).toBe("not-owned");
  });

  test("includes registry-owned devices that are not in bluetoothctl devices", async () => {
    const known = device("AA:AA:AA:AA:AA:AB", { paired: true, trusted: true });
    let connected = false;
    const bluez = {
      devices: async () => [],
      info: async () => ({ ...known, connected }),
      trust: async () => {},
      connect: async () => { connected = true; },
    };
    const registry = {
      list: () => [{
        mac: known.mac,
        category: "input" as const,
        firstSeen: "",
        lastSeen: "",
        seenCount: 1,
        rssiHistory: [],
        uuids: [],
        capabilities: [],
        isKnown: true,
      }],
    };

    const results = await connectOwnedDevices(bluez, { registry });
    expect(results).toHaveLength(1);
    expect(results[0]?.connected).toBeTrue();
    expect(results[0]?.category).toBe("input");
  });

  test("can filter to audio devices and run audio verification", async () => {
    const speaker = device("AA:AA:AA:AA:AA:AC", {
      paired: true,
      trusted: true,
      uuids: ["Audio Sink (0000110b-0000-1000-8000-00805f9b34fb)"],
    });
    const keyboard = device("AA:AA:AA:AA:AA:AD", {
      paired: true,
      trusted: true,
      uuids: ["Human Interface Device (00001124-0000-1000-8000-00805f9b34fb)"],
    });
    let audioFixes = 0;
    const bluez = {
      devices: async () => [speaker, keyboard],
      info: async (mac: string) => ({ ...(mac === speaker.mac ? speaker : keyboard), connected: mac === speaker.mac }),
      trust: async () => {},
      connect: async () => {},
    };

    const results = await connectOwnedDevices(bluez, {
      category: "audio",
      audioFix: true,
      audioManager: {
        ensure: async () => {
          audioFixes++;
          return { serverAvailable: true, cardFound: true, sinkFound: true, availableProfiles: [] };
        },
      },
    });

    expect(results.find(result => result.mac === speaker.mac)?.audio?.sinkFound).toBeTrue();
    expect(results.find(result => result.mac === keyboard.mac)?.skipped).toBe("category-audio");
    expect(audioFixes).toBe(1);
  });
});
