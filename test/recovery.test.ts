import { describe, expect, test } from "bun:test";
import type { Bluez } from "../src/bluez";
import { Recovery, safeMatrix } from "../src/matrix";
import type { DeviceState } from "../src/types";

const state = (overrides: Partial<DeviceState> = {}): DeviceState => ({
  mac: "AC:B1:EE:71:A1:51", available: true, paired: true, bonded: true, trusted: true,
  blocked: false, connected: true, servicesResolved: true, uuids: [], raw: "", ...overrides,
});

describe("convergent recovery", () => {
  test("does not touch an already healthy device", async () => {
    let pairs = 0;
    let connects = 0;
    const fake = {
      prepare: async () => {}, info: async () => state(),
      pair: async () => { pairs++; }, connect: async () => { connects++; },
    } as unknown as Bluez;
    const recovery = new Recovery(fake, { scanSeconds: 1, pairTimeoutMs: 1, connectTimeoutMs: 1 });
    expect((await recovery.run(state().mac, safeMatrix)).connected).toBeTrue();
    expect(pairs).toBe(0);
    expect(connects).toBe(0);
  });

  test("only connects a device whose bond already exists", async () => {
    let current = state({ connected: false, trusted: false });
    let pairs = 0;
    const fake = {
      prepare: async () => {}, info: async () => current,
      trust: async () => { current = state({ connected: false }); },
      connect: async () => { current = state(); },
      pair: async () => { pairs++; },
    } as unknown as Bluez;
    const recovery = new Recovery(fake, { scanSeconds: 1, pairTimeoutMs: 1, connectTimeoutMs: 1 });
    expect((await recovery.run(current.mac, safeMatrix)).connected).toBeTrue();
    expect(pairs).toBe(0);
  });

  test("preserves a usable unbonded session instead of escalating", async () => {
    let removes = 0;
    const partial = state({ bonded: false });
    const fake = {
      prepare: async () => {}, info: async () => partial,
      remove: async () => { removes++; },
    } as unknown as Bluez;
    const recovery = new Recovery(fake, {
      scanSeconds: 1, pairTimeoutMs: 1, connectTimeoutMs: 1, bondWaitMs: 1,
    });
    const result = await recovery.run(partial.mac, safeMatrix);
    expect(result.connected).toBeTrue();
    expect(result.bonded).toBeFalse();
    expect(removes).toBe(0);
  });

  test("preserves a working session when rebond preflight cannot see the target", async () => {
    let disconnects = 0;
    let removes = 0;
    const partial = state({ bonded: false });
    const fake = {
      prepare: async () => {}, info: async () => partial,
      scanLive: async () => [partial], // cached state is not proof of a live advertisement
      disconnect: async () => { disconnects++; },
      remove: async () => { removes++; },
    } as unknown as Bluez;
    const recovery = new Recovery(fake, {
      scanSeconds: 1, pairTimeoutMs: 1, connectTimeoutMs: 1, requireBond: true,
    });
    const result = await recovery.run(partial.mac, safeMatrix);
    expect(result.connected).toBeTrue();
    expect(result.bonded).toBeFalse();
    expect(disconnects).toBe(0);
    expect(removes).toBe(0);
  });

  test("uses live target events to take the safe rebond fast path", async () => {
    let current = state({ bonded: false });
    let removes = 0;
    let pairs = 0;
    let scans = 0;
    const fake = {
      prepare: async () => {}, info: async () => current,
      scanLive: async (_mode: string, _seconds: number, options: { onSeen?: (mac: string) => void }) => {
        scans++;
        options.onSeen?.(current.mac);
        return [current];
      },
      disconnect: async () => { current = { ...current, connected: false }; },
      remove: async () => {
        removes++;
        current = state({ paired: false, bonded: false, trusted: false, connected: false });
      },
      cancelPairing: async () => {},
      pair: async () => {
        pairs++;
        current = state({ bonded: true, trusted: false });
        return { argv: [], exitCode: 0, stdout: "Pairing successful", stderr: "", timedOut: false };
      },
      trust: async () => { current = { ...current, trusted: true }; },
      connect: async () => { current = { ...current, connected: true }; },
    } as unknown as Bluez;
    const recovery = new Recovery(fake, {
      scanSeconds: 1, pairTimeoutMs: 1, connectTimeoutMs: 1, requireBond: true,
    });
    const result = await recovery.run(current.mac, safeMatrix);
    expect(result.bonded).toBeTrue();
    expect(removes).toBe(1);
    expect(pairs).toBe(1);
    expect(scans).toBe(2);
  });

  test("disconnect-probes but does not remove state when explicit rebond cannot find the target", async () => {
    let current = state({ bonded: false });
    let disconnects = 0;
    let connects = 0;
    let removes = 0;
    let scans = 0;
    const fake = {
      prepare: async () => {}, info: async () => current,
      scanLive: async () => { scans++; return [current]; },
      disconnect: async () => { disconnects++; current = { ...current, connected: false }; },
      connect: async () => { connects++; current = { ...current, connected: true }; },
      remove: async () => { removes++; },
    } as unknown as Bluez;
    const recovery = new Recovery(fake, {
      scanSeconds: 1, pairTimeoutMs: 1, connectTimeoutMs: 1,
      requireBond: true, allowSessionDrop: true,
    });
    const result = await recovery.run(current.mac, safeMatrix);
    expect(result.connected).toBeTrue();
    expect(result.bonded).toBeFalse();
    expect(scans).toBe(2);
    expect(disconnects).toBe(1);
    expect(connects).toBe(1);
    expect(removes).toBe(0);
  });
});
