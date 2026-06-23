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
});
