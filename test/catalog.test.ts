import { describe, expect, test } from "bun:test";
import { capabilities } from "../src/catalog";
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
});
