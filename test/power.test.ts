import { describe, expect, test, mock } from "bun:test";
import * as originalFs from "node:fs";

mock.module("node:fs", () => ({
  ...originalFs,
  existsSync: (path: string) => {
    if (typeof path === "string" && path.includes("/sys/")) return true;
    return originalFs.existsSync(path);
  },
  realpathSync: (path: string) => {
    if (typeof path === "string" && path.includes("/sys/class/bluetooth/hci0/device")) {
      return "/sys/devices/pci0000:00/0000:00:14.0/usb1/1-10/1-10:1.0";
    }
    return originalFs.realpathSync(path);
  },
  readFileSync: (path: string, options?: any) => {
    if (typeof path === "string" && path.includes("idVendor")) return "0a5c";
    if (typeof path === "string" && path.includes("idProduct")) return "21e8";
    if (typeof path === "string" && path.includes("power/control")) return "auto";
    if (typeof path === "string" && path.includes("power/runtime_status")) return "active";
    if (typeof path === "string" && path.includes("power/autosuspend_delay_ms")) return "2000";
    if (typeof path === "string" && path.includes("power/runtime_suspended_time")) return "0";
    if (typeof path === "string" && path.includes("enable_autosuspend")) return "Y";
    return originalFs.readFileSync(path, options);
  },
}));

import { adapterPowerState } from "../src/power";

describe("adapter power inspection", () => {
  test("locates the active USB Bluetooth adapter", () => {
    const state = adapterPowerState();
    expect(state.vendor).toMatch(/^[0-9a-f]{4}$/);
    expect(state.product).toMatch(/^[0-9a-f]{4}$/);
    expect(["auto", "on"]).toContain(state.control ?? "");
  });
});
