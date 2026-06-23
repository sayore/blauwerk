import { describe, expect, test } from "bun:test";
import { adapterPowerState } from "../src/power";

describe("adapter power inspection", () => {
  test("locates the active USB Bluetooth adapter", () => {
    const state = adapterPowerState();
    expect(state.vendor).toMatch(/^[0-9a-f]{4}$/);
    expect(state.product).toMatch(/^[0-9a-f]{4}$/);
    expect(["auto", "on"]).toContain(state.control ?? "");
  });
});
