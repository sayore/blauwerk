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
  private targetSeenInPreflight = false;
  constructor(private readonly bluez: Bluez, private readonly options: {
    scanSeconds: number;
    pairTimeoutMs: number;
    connectTimeoutMs: number;
    bondWaitMs?: number;
    requireBond?: boolean;
    allowSessionDrop?: boolean;
  }) {}

  private async once(key: string, action: () => Promise<void>): Promise<void> {
    if (this.completed.has(key)) return;
    await action();
    this.completed.add(key);
  }

  private async connect(mac: string): Promise<DeviceState> {
    let state = await this.bluez.info(mac);
    if (state.blocked) {
      log("device.unblock", { mac });
      await this.bluez.unblock(mac).catch(error => log("unblock.failed", { error: String(error) }));
      state = await this.bluez.info(mac);
    }
    if (!state.trusted) await this.bluez.trust(mac);
    if (!state.connected) {
      const maxConnectAttempts = 3;
      let connectError: any = null;
      
      for (let attempt = 1; attempt <= maxConnectAttempts; attempt++) {
        connectError = null;
        if (attempt > 1) {
          log("connect.retry", { mac, attempt, maxAttempts: maxConnectAttempts });
          await Bun.sleep(2_000);
        }
        
        await this.bluez.connect(mac, undefined, this.options.connectTimeoutMs)
          .catch(error => {
            connectError = error;
            log("connect.failed", { profile: "default", attempt, error: String(error) });
          });
        
        if (!connectError) {
          break;
        }
        
        const errMsg = String(connectError);
        if (state.paired && /AuthenticationFailed|Key missing|Link key|Authentication Failed/i.test(errMsg)) {
          break;
        }
      }
      
      if (connectError) {
        const errMsg = String(connectError);
        if (state.paired && /AuthenticationFailed|Key missing|Link key|Authentication Failed/i.test(errMsg)) {
          log("recovery.ctkd-mismatch", { mac, error: errMsg });
          log("recovery.reset-ctkd", { message: "CTKD / dual-bearer key mismatch detected. Removing host-side bond to force fresh link key exchange." });
          await this.bluez.disconnect(mac).catch(() => {});
          await this.bluez.remove(mac).catch(() => {});
          state = await this.bluez.info(mac);
        } else if (this.targetSeenInPreflight && /org\.bluez\.Error\.Failed|Host is down|Connection timed out/i.test(errMsg)) {
          log("recovery.stop", {
            reason: "multipoint-conflict",
            message: "Device was seen advertising in preflight scan but refused to connect (page timeout). This signature typically indicates that the device is already connected to another host (like a phone). Disconnect it from other hosts and try again."
          });
        }
      } else {
        const deadline = Date.now() + 10_000;
        do {
          state = await this.bluez.info(mac);
          if (state.connected) break;
          await Bun.sleep(1_000);
        } while (Date.now() < deadline);
      }
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

  private async scanFor(mac: string, mode: Attempt["scan"], seconds = this.options.scanSeconds): Promise<{ devices: DeviceState[]; targetSeen: boolean }> {
    const controller = new AbortController();
    let targetSeen = false;
    log("scan.start", { mode, seconds });
    const devices = await this.bluez.scanLive(mode, seconds, {
      signal: controller.signal,
      onSeen: seenMac => {
        if (seenMac !== mac) return;
        targetSeen = true;
        controller.abort();
      },
    });
    log("scan.end", { devices: devices.length, targetSeen, stoppedEarly: targetSeen });
    if (targetSeen) {
      this.targetSeenInPreflight = true;
    }
    return { devices, targetSeen };
  }

  async run(mac: string, matrix: Attempt[]): Promise<DeviceState> {
    await this.bluez.prepare();
    let state = await this.bluez.info(mac);
    if (state.paired) {
      state = await this.connect(mac);
      if (this.mayStop(state)) return state;
      if (this.options.requireBond && state.bonded === false) {
        log("recovery.fast-path", { reason: "rebond-required", phase: "advertising-preflight" });
        let preflight = await this.scanFor(mac, "bredr", state.connected ? Math.min(3, this.options.scanSeconds) : this.options.scanSeconds);
        if (!preflight.targetSeen && state.connected && this.options.allowSessionDrop) {
          log("recovery.fast-path", { reason: "rebond-required", phase: "disconnect-probe" });
          log("recovery.user-action", { message: "Keep the device in host pairing mode during the next discovery window." });
          await this.bluez.disconnect(mac).catch(error => log("disconnect.failed", { error: String(error) }));
          await Bun.sleep(500);
          await this.bluez.prepare();
          
          const maxAttempts = 3;
          const scanSecondsPerAttempt = this.options.scanSeconds > 0 ? this.options.scanSeconds : 10;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            console.log(`\n\x1b[1m\x1b[33m>>> ACTION REQUIRED: Put your device in PAIRING/BONDING mode now! <<<\x1b[0m`);
            console.log(`\x1b[1m(For Keychron keyboards: hold Fn + 1 (or 2/3) for 3-5 seconds until the Bluetooth LED flashes rapidly)\x1b[0m`);
            console.log(`Waiting ${scanSecondsPerAttempt} seconds for device to start advertising... (Attempt ${attempt} of ${maxAttempts})\n`);
            
            preflight = await this.scanFor(mac, "bredr", scanSecondsPerAttempt);
            if (preflight.targetSeen) {
              log("recovery.fast-path", { reason: "rebond-required", phase: "target-detected", attempt });
              break;
            }
          }
        }
        if (!preflight.targetSeen) {
          if (this.options.allowSessionDrop) {
            log("recovery.rollback", { phase: "restore-working-session" });
            state = await this.connect(mac);
          }
          log("recovery.stop", {
            reason: "rebond-target-not-advertising",
            message: this.options.allowSessionDrop
              ? "Target did not advertise after disconnect; reconnect was attempted and BlueZ state was not removed."
              : "Working session preserved. Put the device in pairing mode before rebonding.",
          });
          return state;
        }
        log("recovery.fast-path", { reason: "rebond-required", phase: "remove-ephemeral-pairing" });
        await this.bluez.disconnect(mac).catch(() => {});
        await this.bluez.remove(mac).catch(() => {});
        state = await this.bluez.info(mac);
      } else {
        state = await this.settleBond(mac, state);
        if (this.mayStop(state)) return state;
      }
    }

    for (const [index, attempt] of matrix.entries()) {
      log("attempt.start", { index: index + 1, ...attempt });
      try {
        state = await this.bluez.info(mac);
        if (healthy(state)) return state;
        if (state.paired) {
          state = await this.connect(mac);
          if (this.mayStop(state)) return state;
          state = await this.settleBond(mac, state);
          if (this.mayStop(state)) return state;
          await this.bluez.disconnect(mac).catch(() => {});
        }
        if (attempt.reset === "remove") await this.bluez.remove(mac).catch(() => {});
        if (attempt.reset === "restart") await this.once("restart", () => this.bluez.restartBluetooth());
        if (attempt.reset === "purge") await this.once("purge", () => this.bluez.purge(mac));
        if (attempt.reset === "powercycle") await this.once("powercycle", () => this.bluez.powercycle());
        await this.bluez.prepare();
        let scanResult = await this.scanFor(mac, attempt.scan);
        if (!scanResult.targetSeen && this.options.requireBond) {
          const maxAttempts = 3;
          const scanSecondsPerAttempt = this.options.scanSeconds > 0 ? this.options.scanSeconds : 10;
          for (let attemptNum = 1; attemptNum <= maxAttempts; attemptNum++) {
            console.log(`\n\x1b[1m\x1b[33m>>> ACTION REQUIRED: Put your device in PAIRING/BONDING mode now! <<<\x1b[0m`);
            console.log(`\x1b[1m(For Keychron keyboards: hold Fn + 1 (or 2/3) for 3-5 seconds until the Bluetooth LED flashes rapidly)\x1b[0m`);
            console.log(`Waiting ${scanSecondsPerAttempt} seconds for device to start advertising... (Attempt ${attemptNum} of ${maxAttempts})\n`);
            
            scanResult = await this.scanFor(mac, attempt.scan, scanSecondsPerAttempt);
            if (scanResult.targetSeen) {
              break;
            }
          }
        }
        const targetSeen = scanResult.targetSeen;
        state = await this.bluez.info(mac);
        if (!targetSeen) {
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
            let pin: string | undefined = undefined;
            if (state.legacyPairing) {
              const pins = ["0000", "1234", "1111"];
              pin = pins[index % pins.length];
              log("recovery.legacy-pin-attempt", { mac, pin });
            }
            const result = await this.bluez.pair(mac, attempt.agent, this.options.pairTimeoutMs, pin);
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
          log("recovery.stop", {
            reason: "pair-lost",
            message: "Remote or controller dropped the successful pairing. This signature (transient pair followed by immediate loss) typically indicates that the remote device's bond/pairing table is full. Clear the pairing history on your device and try again."
          });
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
      }
    }
    return this.bluez.info(mac);
  }
}
