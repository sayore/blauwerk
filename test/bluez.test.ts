import { describe, expect, test } from "bun:test";
import { normalizeMac, parseDeviceInfo, parseDiscoveryLine } from "../src/bluez";
import { healthy } from "../src/matrix";

describe("BlueZ state parsing", () => {
  test("parses a healthy device", () => {
    const state = parseDeviceInfo(`Device AC:B1:EE:71:A1:51\n Name: Tribit\n Paired: yes\n Bonded: yes\n Trusted: yes\n Blocked: no\n Connected: yes\n ServicesResolved: yes\n UUID: Audio Sink`);
    expect(state.mac).toBe("AC:B1:EE:71:A1:51");
    expect(state.name).toBe("Tribit");
    expect(state.available).toBeTrue();
    expect(state.servicesResolved).toBeTrue();
    expect(healthy(state)).toBeTrue();
  });

  test("accepts BlueZ versions without Bonded", () => {
    const state = parseDeviceInfo("Paired: yes\nConnected: yes");
    expect(state.bonded).toBeUndefined();
    expect(healthy(state)).toBeTrue();
  });

  test("rejects unsafe MAC input", () => {
    expect(() => normalizeMac("../../etc/passwd")).toThrow();
    expect(normalizeMac("ac:b1:ee:71:a1:51")).toBe("AC:B1:EE:71:A1:51");
  });

  test("marks BlueZ's not-available response explicitly", () => {
    expect(parseDeviceInfo("Device AC:B1:EE:71:A1:51 not available").available).toBeFalse();
  });

  test("parses bluetoothctl's hexadecimal RSSI representation", () => {
    expect(parseDeviceInfo("RSSI: 0xffffffc1 (-63)").rssi).toBe(-63);
  });

  test("extracts live discovery events without treating properties as names", () => {
    expect(parseDiscoveryLine("[NEW] Device AC:B1:EE:71:A1:51 Tribit Home Speaker")).toEqual({
      mac: "AC:B1:EE:71:A1:51", name: "Tribit Home Speaker",
    });
    expect(parseDiscoveryLine("[CHG] Device AC:B1:EE:71:A1:51 Alias: Living Room")).toEqual({
      mac: "AC:B1:EE:71:A1:51", name: "Living Room",
    });
    expect(parseDiscoveryLine("[CHG] Device AC:B1:EE:71:A1:51 RSSI: 0xffffffc1 (-63)")).toEqual({
      mac: "AC:B1:EE:71:A1:51",
    });
  });
});
