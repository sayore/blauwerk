import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceRegistry, classifyDevice } from "../src/registry";
import type { DeviceState } from "../src/types";

describe("DeviceRegistry", () => {
  let tempDir = "";
  let dbPath = "";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "blauwerk-registry-test-"));
    dbPath = join(tempDir, "registry.json");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true });
  });

  test("loads empty registry if file does not exist", () => {
    const reg = new DeviceRegistry(dbPath);
    expect(reg.list()).toHaveLength(0);
  });

  test("records and atomic-saves new device", () => {
    const reg = new DeviceRegistry(dbPath);
    const state: DeviceState = {
      mac: "AA:BB:CC:DD:EE:FF",
      available: true,
      paired: false,
      trusted: false,
      blocked: false,
      connected: false,
      name: "Soundcore",
      uuids: ["0000110b-0000-1000-8000-00805f9b34fb"],
      rssi: -50,
      raw: "",
    };

    const recorded = reg.record(state);
    expect(recorded.mac).toBe(state.mac);
    expect(recorded.name).toBe("Soundcore");
    expect(recorded.category).toBe("audio");
    expect(recorded.seenCount).toBe(1);
    expect(recorded.rssiHistory).toHaveLength(1);
    expect(recorded.rssiHistory[0]?.rssi).toBe(-50);

    // Verify it saved to disk and loads correctly
    const reg2 = new DeviceRegistry(dbPath);
    expect(reg2.list()).toHaveLength(1);
    expect(reg2.get(state.mac)?.name).toBe("Soundcore");
  });

  test("merges device details and caps uniquely on subsequent records", () => {
    const reg = new DeviceRegistry(dbPath);
    const state1: DeviceState = {
      mac: "AA:BB:CC:DD:EE:FF", available: true, paired: false, trusted: false, blocked: false, connected: false,
      name: "Soundcore", uuids: ["0000110b-0000-1000-8000-00805f9b34fb"], rssi: -50, raw: "",
    };
    reg.record(state1);

    const state2: DeviceState = {
      mac: "AA:BB:CC:DD:EE:FF", available: true, paired: true, trusted: true, blocked: false, connected: true,
      alias: "My Speaker", uuids: ["0000110c-0000-1000-8000-00805f9b34fb"], rssi: -45, raw: "",
    };
    const merged = reg.record(state2);

    expect(merged.name).toBe("Soundcore");
    expect(merged.alias).toBe("My Speaker");
    expect(merged.isKnown).toBeTrue();
    expect(merged.seenCount).toBe(2);
    expect(merged.uuids).toContain("0000110b-0000-1000-8000-00805f9b34fb");
    expect(merged.uuids).toContain("0000110c-0000-1000-8000-00805f9b34fb");
    expect(merged.rssiHistory).toHaveLength(2);
  });

  test("caps RSSI history to last 10 entries", () => {
    const reg = new DeviceRegistry(dbPath);
    const baseState: DeviceState = {
      mac: "AA:BB:CC:DD:EE:FF", available: true, paired: false, trusted: false, blocked: false, connected: false,
      uuids: [], raw: "",
    };

    for (let i = 0; i < 15; i++) {
      reg.record({ ...baseState, rssi: -40 - i });
    }

    const device = reg.get(baseState.mac);
    expect(device?.rssiHistory).toHaveLength(10);
    // Last entry should be the most recent one (-54)
    expect(device?.rssiHistory[9]?.rssi).toBe(-54);
  });

  test("classifies categories based on CoD, Icon, UUIDs and names", () => {
    // 1. CoD Audio Class
    const s1: DeviceState = { mac: "11:11:11:11:11:11", available: true, paired: false, trusted: false, blocked: false, connected: false, class: "0x240404", uuids: [], raw: "" };
    expect(classifyDevice(s1, { profiles: [], intents: [] })).toBe("audio");

    // 2. CoD Input Class
    const s2: DeviceState = { mac: "22:22:22:22:22:22", available: true, paired: false, trusted: false, blocked: false, connected: false, class: "0x002540", uuids: [], raw: "" };
    expect(classifyDevice(s2, { profiles: [], intents: [] })).toBe("input");

    // 3. Icon Computer
    const s3: DeviceState = { mac: "33:33:33:33:33:33", available: true, paired: false, trusted: false, blocked: false, connected: false, icon: "computer", uuids: [], raw: "" };
    expect(classifyDevice(s3, { profiles: [], intents: [] })).toBe("computer");

    // 4. UUID HOGP
    const s4: DeviceState = { mac: "44:44:44:44:44:44", available: true, paired: false, trusted: false, blocked: false, connected: false, uuids: ["00001812-0000-1000-8000-00805f9b34fb"], raw: "" };
    expect(classifyDevice(s4, { profiles: [], intents: [] })).toBe("input");

    // 5. Name match fallback
    const s5: DeviceState = { mac: "55:55:55:55:55:55", available: true, paired: false, trusted: false, blocked: false, connected: false, name: "Living Room TV", uuids: [], raw: "" };
    expect(classifyDevice(s5, { profiles: [], intents: [] })).toBe("imaging");
  });
});
