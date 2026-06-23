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
});
