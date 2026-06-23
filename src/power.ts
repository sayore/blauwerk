import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { run } from "./process";

export interface AdapterPowerState {
  path: string;
  vendor?: string;
  product?: string;
  control?: string;
  runtimeStatus?: string;
  autosuspendDelayMs?: number;
  runtimeSuspendedMs?: number;
  btusbAutosuspend?: boolean;
}

const read = (path: string) => existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;

function usbDevicePath(): string {
  let path = realpathSync("/sys/class/bluetooth/hci0/device");
  while (path !== "/") {
    if (existsSync(join(path, "idVendor")) && existsSync(join(path, "idProduct"))) return path;
    path = dirname(path);
  }
  throw new Error("Could not locate the USB parent of hci0");
}

export function adapterPowerState(): AdapterPowerState {
  const path = usbDevicePath();
  return {
    path, vendor: read(join(path, "idVendor")), product: read(join(path, "idProduct")),
    control: read(join(path, "power/control")), runtimeStatus: read(join(path, "power/runtime_status")),
    autosuspendDelayMs: Number(read(join(path, "power/autosuspend_delay_ms"))),
    runtimeSuspendedMs: Number(read(join(path, "power/runtime_suspended_time"))),
    btusbAutosuspend: read("/sys/module/btusb/parameters/enable_autosuspend") === "Y",
  };
}

async function privilegedWrite(path: string, content: string): Promise<void> {
  await run(["sudo", "tee", path], { input: `${content}\n`, timeoutMs: 30_000 });
}

export async function disableAdapterAutosuspend(persistent = false): Promise<{ state: AdapterPowerState; rule?: string }> {
  const before = adapterPowerState();
  await privilegedWrite(join(before.path, "power/control"), "on");
  if (!persistent) return { state: adapterPowerState() };
  if (!before.vendor || !before.product) throw new Error("USB vendor/product ID unavailable");
  const rulePath = "/etc/udev/rules.d/80-blauwerk-power.rules";
  const temporary = join(tmpdir(), `blauwerk-power-${process.pid}.rules`);
  const rule = `ACTION=="add", SUBSYSTEM=="usb", ATTR{idVendor}=="${before.vendor}", ATTR{idProduct}=="${before.product}", TEST=="power/control", ATTR{power/control}="on"\n`;
  writeFileSync(temporary, rule, { mode: 0o600 });
  try {
    await run(["sudo", "install", "-m", "0644", temporary, rulePath], { timeoutMs: 30_000 });
  } finally {
    try { unlinkSync(temporary); } catch { /* best effort */ }
  }
  return { state: adapterPowerState(), rule: rulePath };
}
