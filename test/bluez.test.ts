import { describe, expect, test } from "bun:test";
import {
  cleanBluetoothctlOutput,
  connectOutputShowsCommandSuccess,
  connectOutputShowsConnected,
  connectOutputShowsProgress,
  normalizeMac,
  parseControllerState,
  parseDeviceInfo,
  parseDiscoveryLine,
} from "../src/bluez";
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
      mac: "AC:B1:EE:71:A1:51", rssi: -63,
    });
    expect(parseDiscoveryLine("[CHG] Device AC:B1:EE:71:A1:51 Class: 0x240404")).toEqual({
      mac: "AC:B1:EE:71:A1:51", class: "0x240404",
    });
    expect(parseDiscoveryLine("[CHG] Device AC:B1:EE:71:A1:51 Icon: audio-card")).toEqual({
      mac: "AC:B1:EE:71:A1:51", icon: "audio-card",
    });
  });

  test("extracts discovery events from colored bluetoothctl prompt lines", () => {
    expect(parseDiscoveryLine("[bluetooth]# [\u001B[0;93mCHG\u001B[0m] Device AC:B1:EE:71:A1:51 RSSI: 0xffffffc1 (-63)")).toEqual({
      mac: "AC:B1:EE:71:A1:51", rssi: -63,
    });
    expect(parseDiscoveryLine("\u001B[K[\u001B[0;92mNEW\u001B[0m] Device AC:B1:EE:71:A1:51 Tribit Home Speaker")).toEqual({
      mac: "AC:B1:EE:71:A1:51", name: "Tribit Home Speaker",
    });
    expect(parseDiscoveryLine("[CHG] Device AC:B1:EE:71:A1:51 Class: 0x00240414 (2360340)")).toEqual({
      mac: "AC:B1:EE:71:A1:51", class: "0x00240414 (2360340)",
    });
  });

  test("recognizes profile connect progress and connected events from noisy bluetoothctl output", () => {
    const noisy = "Waiting to connect to bluetoothd...\r\u001B[0;94m[bluetoothctl]> \u001B[0mconnect AC:B1:EE:71:A1:51 0000110b-0000-1000-8000-00805f9b34fb\n[\u001B[0;93mCHG\u001B[0m] Device AC:B1:EE:71:A1:51 Connected: yes\n\u001B[0;94m[Tribit Home Speaker]> \u001B[0m";
    expect(connectOutputShowsConnected(noisy)).toBeTrue();
    expect(cleanBluetoothctlOutput(noisy)).not.toContain("\u001B");
    expect(cleanBluetoothctlOutput(noisy)).not.toContain("[bluetoothctl]>");
  });

  test("does not treat an ACL state probe as profile command success", () => {
    expect(connectOutputShowsConnected("[CHG] Device AC:B1:EE:71:A1:51 Connected: yes")).toBeTrue();
    expect(connectOutputShowsCommandSuccess("[CHG] Device AC:B1:EE:71:A1:51 Connected: yes")).toBeFalse();
    expect(connectOutputShowsCommandSuccess("Connection successful")).toBeTrue();
  });

  test("recognizes BlueZ in-progress profile connect as recoverable progress", () => {
    expect(connectOutputShowsProgress("Failed to connect: org.bluez.Error.InProgress br-connection-busy")).toBeTrue();
  });

  test("detects controller power transition states", () => {
    const state = parseControllerState(`Controller F4:4E:FC:EE:86:BF (public)
      Powered: yes
      PowerState: on-disabling
      Discovering: no`);
    expect(state.controllerAvailable).toBeTrue();
    expect(state.controllerMac).toBe("F4:4E:FC:EE:86:BF");
    expect(state.powerState).toBe("on-disabling");
    expect(state.powerTransitionStuck).toBeTrue();
  });

  test("detects missing default controller output", () => {
    const state = parseControllerState("No default controller available");
    expect(state.controllerAvailable).toBeFalse();
    expect(state.controllerMac).toBeUndefined();
  });

  test("parses device properties: Alias, Icon, Class, and AddressType", () => {
    const raw = "Device AA:BB:CC:DD:EE:FF (public)\n Alias: My Speaker\n Icon: audio-card\n Class: 0x240404\n Paired: yes\n Connected: yes";
    const state = parseDeviceInfo(raw);
    expect(state.mac).toBe("AA:BB:CC:DD:EE:FF");
    expect(state.addressType).toBe("public");
    expect(state.alias).toBe("My Speaker");
    expect(state.icon).toBe("audio-card");
    expect(state.class).toBe("0x240404");
  });

  test("parses device properties with trailing and leading spaces", () => {
    const raw = "Device AA:BB:CC:DD:EE:FF\n\tAlias:   My Speaker   \n\tIcon:   audio-card   ";
    const state = parseDeviceInfo(raw);
    expect(state.alias).toBe("My Speaker");
    expect(state.icon).toBe("audio-card");
  });

  test("handles empty/missing properties by returning undefined", () => {
    const state = parseDeviceInfo("Device AA:BB:CC:DD:EE:FF\n Paired: no");
    expect(state.alias).toBeUndefined();
    expect(state.icon).toBeUndefined();
    expect(state.class).toBeUndefined();
  });

  test("parses battery percentage with different hexadecimal patterns", () => {
    expect(parseDeviceInfo("Battery Percentage: 0x5a (90)").battery).toBe(90);
    expect(parseDeviceInfo("Battery Percentage: 90").battery).toBe(90);
  });

  test("handles missing battery percentage by returning undefined", () => {
    expect(parseDeviceInfo("Device AA:BB:CC:DD:EE:FF\n Paired: yes").battery).toBeUndefined();
  });

  test("parses discovery lines with invalid properties and ignores them", () => {
    expect(parseDiscoveryLine("[CHG] Device AC:B1:EE:71:A1:51 TxPower: 12")).toEqual({
      mac: "AC:B1:EE:71:A1:51",
    });
  });

  test("parses discovery lines with new devices having no name", () => {
    expect(parseDiscoveryLine("[NEW] Device AC:B1:EE:71:A1:51")).toEqual({
      mac: "AC:B1:EE:71:A1:51",
    });
  });

  test("returns undefined for completely malformed discovery lines", () => {
    expect(parseDiscoveryLine("random text")).toBeUndefined();
    expect(parseDiscoveryLine("[NEW] completely broken")).toBeUndefined();
  });

  test("normalizes lowercase MAC addresses successfully", () => {
    expect(normalizeMac("aa:bb:cc:dd:ee:ff")).toBe("AA:BB:CC:DD:EE:FF");
  });

  test("rejects MAC addresses that contain invalid hexadecimal characters", () => {
    expect(() => normalizeMac("AA:BB:CC:DD:EE:GG")).toThrow();
  });

  test("rejects MAC addresses that are too short", () => {
    expect(() => normalizeMac("AA:BB:CC")).toThrow();
  });

  test("rejects MAC addresses that are too long", () => {
    expect(() => normalizeMac("AA:BB:CC:DD:EE:FF:GG")).toThrow();
  });

  test("parses multiple services and extracts them into UUIDs array", () => {
    const raw = "Device AA:BB:CC:DD:EE:FF\n UUID: Audio Sink\n UUID: AVRCP Target";
    const state = parseDeviceInfo(raw);
    expect(state.uuids).toEqual(["Audio Sink", "AVRCP Target"]);
  });

  test("handles legacyPairing property correctly", () => {
    expect(parseDeviceInfo("LegacyPairing: yes").legacyPairing).toBeTrue();
    expect(parseDeviceInfo("LegacyPairing: no").legacyPairing).toBeFalse();
    expect(parseDeviceInfo("").legacyPairing).toBeUndefined();
  });
});
