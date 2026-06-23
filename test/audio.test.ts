import { describe, expect, test } from "bun:test";

// Association uses the canonical PipeWire/BlueZ MAC representation.
describe("audio identity", () => {
  test("normalizes a Bluetooth MAC to the bluez object suffix", () => {
    expect("AC:B1:EE:71:A1:51".replaceAll(":", "_").toLowerCase()).toBe("ac_b1_ee_71_a1_51");
  });
});
