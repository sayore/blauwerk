import { Bluez } from "./bluez";
import { log } from "./log";
import type { Attempt, DeviceState } from "./types";


export const safeMatrix: Attempt[] = [
  { agent: "NoInputNoOutput", scan: "bredr", reset: "none" },
  { agent: "NoInputNoOutput", scan: "on", reset: "none" },
  { agent: "DisplayYesNo", scan: "bredr", reset: "remove" },
  { agent: "NoInputNoOutput", scan: "on", reset: "restart" },
];

export const aggressiveMatrix: Attempt[] = [
  ...safeMatrix,
  { agent: "NoInputNoOutput", scan: "bredr", reset: "purge" },
  { agent: "DisplayYesNo", scan: "bredr", reset: "powercycle" },
];

export function healthy(state: DeviceState): boolean {
  return state.paired && state.bonded !== false && state.connected;
}

export function usable(state: DeviceState): boolean {
  return state.paired && state.connected;
}

export class Recovery {
  private completed = new Set<string>();
  constructor(private readonly bluez: Bluez, private readonly options: {
    scanSeconds: number;
    pairTimeoutMs: number;
    connectTimeoutMs: number;
    bondWaitMs?: number;
    requireBond?: boolean;
  }) {}

  private async once(key: string, action: () => Promise<void>): Promise<void> {
    if (this.completed.has(key)) return;
    await action();
    this.completed.add(key);
  }

  private async connect(mac: string): Promise<DeviceState> {
    let state = await this.bluez.info(mac);
    if (!state.trusted) await this.bluez.trust(mac);
    if (!state.connected) {
      await this.bluez.connect(mac, undefined, this.options.connectTimeoutMs)
        .catch(error => log("connect.failed", { profile: "default", error: String(error) }));
      const deadline = Date.now() + 10_000;
      do {
        state = await this.bluez.info(mac);
        if (state.connected) break;
        await Bun.sleep(1_000);
      } while (Date.now() < deadline);
    }
    return state;
  }

  private async settleBond(mac: string, initial: DeviceState): Promise<DeviceState> {
    if (!usable(initial)) return initial;
    const servicesReady = (state: DeviceState) => state.servicesResolved === true || state.uuids.length > 0;
    if (initial.bonded !== false && servicesReady(initial)) return initial;
    const waitMs = this.options.bondWaitMs ?? 15_000;
    log("device.settle", { seconds: waitMs / 1_000, waitingForBond: initial.bonded === false, waitingForServices: !servicesReady(initial) });
    const deadline = Date.now() + waitMs;
    let state = initial;
    while (Date.now() < deadline) {
      await Bun.sleep(Math.min(1_000, Math.max(1, deadline - Date.now())));
      state = await this.bluez.info(mac);
      if ((healthy(state) && servicesReady(state)) || !usable(state)) break;
    }
    log("device.result", { paired: state.paired, bonded: state.bonded, connected: state.connected, servicesResolved: state.servicesResolved, uuids: state.uuids.length });
    return state;
  }

  private mayStop(state: DeviceState): boolean {
    return healthy(state) || (usable(state) && !this.options.requireBond);
  }

  async run(mac: string, matrix: Attempt[]): Promise<DeviceState> {
    await this.bluez.prepare();
    let state = await this.bluez.info(mac);
    if (state.paired) {
      state = await this.connect(mac);
      state = await this.settleBond(mac, state);
      if (this.mayStop(state)) return state;
    }

    for (const [index, attempt] of matrix.entries()) {
      log("attempt.start", { index: index + 1, ...attempt });
      try {
        state = await this.bluez.info(mac);
        if (healthy(state)) return state;
        if (state.paired) {
          state = await this.connect(mac);
          state = await this.settleBond(mac, state);
          if (this.mayStop(state)) return state;
          await this.bluez.disconnect(mac).catch(() => {});
        }
        if (attempt.reset === "remove") await this.bluez.remove(mac).catch(() => {});
        if (attempt.reset === "restart") await this.once("restart", () => this.bluez.restartBluetooth());
        if (attempt.reset === "purge") await this.once("purge", () => this.bluez.purge(mac));
        if (attempt.reset === "powercycle") await this.once("powercycle", () => this.bluez.powercycle());
        await this.bluez.prepare();
        log("scan.start", { mode: attempt.scan, seconds: this.options.scanSeconds });
        const devices = await this.bluez.scan(attempt.scan, this.options.scanSeconds);
        log("scan.end", { devices: devices.length, targetSeen: devices.some(device => device.mac === mac) });
        state = await this.bluez.info(mac);
        if (!state.available) {
          const message = `Target ${mac} was not seen during ${this.options.scanSeconds}s ${attempt.scan} scan`;
          if (attempt.scan === "on") {
            log("recovery.stop", { reason: "target-not-advertising", message });
            return state;
          }
          throw new Error(message);
        }
        let pairedThisAttempt = false;
        if (!state.paired) {
          await this.bluez.cancelPairing(mac).catch(() => {});
          pairedThisAttempt = true;
          try {
            const result = await this.bluez.pair(mac, attempt.agent, this.options.pairTimeoutMs);
            log("pair.result", {
              exitCode: result.exitCode,
              output: `${result.stdout}\n${result.stderr}`.trim().slice(-2_000),
            });
          } catch (error) {
            await Bun.sleep(750);
            state = await this.bluez.info(mac);
            if (state.paired) {
              log("pair.reconciled", { message: "bluetoothctl failed, but BlueZ reports Paired=yes" });
            } else {
              await this.bluez.cancelPairing(mac).catch(() => {});
              await this.bluez.disconnect(mac).catch(() => {});
              throw error;
            }
          }
        }
        state = await this.connect(mac);
        state = await this.settleBond(mac, state);
        log("attempt.end", { paired: state.paired, bonded: state.bonded, connected: state.connected });
        if (this.mayStop(state)) return state;
        if (pairedThisAttempt && !state.paired) {
          log("recovery.stop", { reason: "pair-lost", message: "remote or controller dropped the successful pairing" });
          return state;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log("attempt.error", { index: index + 1, error: message });
        if (/org\.bluez\.Error\.AuthenticationFailed/i.test(message)) {
          await this.bluez.cancelPairing(mac).catch(() => {});
          log("recovery.stop", {
            reason: "authentication-rejected",
            message: "the remote device rejected authentication; host stack escalation cannot repair this",
          });
          return this.bluez.info(mac);
        }
      } finally {
        await this.bluez.stopScan().catch(() => {});
      }
    }
    return this.bluez.info(mac);
  }
}
