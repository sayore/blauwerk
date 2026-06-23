import { Bluez } from "./bluez";
import { log } from "./log";
import { commandExists, run } from "./process";
import type { AudioState } from "./types";

type JsonObject = Record<string, unknown>;
const A2DP_SINK_UUID = "0000110b-0000-1000-8000-00805f9b34fb";

function objects(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(item => item && typeof item === "object") as JsonObject[] : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export class AudioManager {
  private async pactlJson(kind: "cards" | "sinks"): Promise<{ data: JsonObject[]; error?: string }> {
    if (!await commandExists("pactl")) return { data: [], error: "pactl is missing" };
    const result = await run(["pactl", "-f", "json", "list", kind], { allowFailure: true, timeoutMs: 10_000 });
    if (result.exitCode !== 0) return { data: [], error: (result.stderr || result.stdout).trim() };
    try { return { data: objects(JSON.parse(result.stdout)) }; }
    catch { return { data: [], error: `Invalid pactl JSON for ${kind}` }; }
  }

  async state(mac: string): Promise<AudioState> {
    const needles = [mac.toLowerCase(), mac.replaceAll(":", "_").toLowerCase()];
    const [cardsResult, sinksResult] = await Promise.all([this.pactlJson("cards"), this.pactlJson("sinks")]);
    const matches = (entry: JsonObject) => needles.some(needle => JSON.stringify(entry).toLowerCase().includes(needle));
    const card = cardsResult.data.find(matches);
    const sink = sinksResult.data.find(matches);
    const profiles = objects(card?.profiles);
    const active = card?.active_profile;
    const activeProfile = typeof active === "object" && active ? text((active as JsonObject).name) : text(active);
    return {
      serverAvailable: !cardsResult.error && !sinksResult.error,
      cardFound: Boolean(card), sinkFound: Boolean(sink),
      cardName: text(card?.name), sinkName: text(sink?.name), activeProfile,
      availableProfiles: profiles
        .filter(profile => text(profile.available) !== "no")
        .map(profile => text(profile.name)).filter((name): name is string => Boolean(name)),
      error: cardsResult.error ?? sinksResult.error,
    };
  }

  private async wait(mac: string, seconds: number): Promise<AudioState> {
    const deadline = Date.now() + seconds * 1_000;
    let state = await this.state(mac);
    while (!state.sinkFound && Date.now() < deadline) {
      await Bun.sleep(1_000);
      state = await this.state(mac);
    }
    return state;
  }

  private async activateA2dp(state: AudioState): Promise<void> {
    if (!state.cardName) return;
    const profile = state.availableProfiles.find(name => /^a2dp-sink(?:-|$)/.test(name));
    if (!profile || state.activeProfile === profile) return;
    const result = await run(["pactl", "set-card-profile", state.cardName, profile], { allowFailure: true, timeoutMs: 10_000 });
    log("audio.profile", { card: state.cardName, profile, exitCode: result.exitCode });
  }

  private async waitBluetooth(bluez: Bluez, mac: string, connected: boolean, seconds: number): Promise<boolean> {
    const deadline = Date.now() + seconds * 1_000;
    do {
      if ((await bluez.info(mac)).connected === connected) return true;
      await Bun.sleep(500);
    } while (Date.now() < deadline);
    return false;
  }

  async ensure(bluez: Bluez, mac: string): Promise<AudioState> {
    const servicesDeadline = Date.now() + 10_000;
    let bluetooth = await bluez.info(mac);
    while (bluetooth.connected && bluetooth.servicesResolved !== true && bluetooth.uuids.length === 0 && Date.now() < servicesDeadline) {
      await Bun.sleep(1_000);
      bluetooth = await bluez.info(mac);
    }
    log("audio.bluez-services", {
      connected: bluetooth.connected,
      servicesResolved: bluetooth.servicesResolved,
      uuids: bluetooth.uuids.length,
    });
    let state = await this.wait(mac, 5);
    log("audio.state", { ...state });
    if (state.sinkFound) return state;

    if (state.cardFound) {
      await this.activateA2dp(state);
      state = await this.wait(mac, 5);
      if (state.sinkFound) return state;
    }

    if (!state.serverAvailable) await bluez.restartAudio();

    let targetSeen: boolean | undefined;
    bluetooth = await bluez.info(mac);
    if (!bluetooth.connected) {
      log("audio.scan", { mode: "bredr", seconds: 10 });
      const devices = await bluez.scan("bredr", 10);
      targetSeen = devices.some(device => device.mac === mac);
      if (!targetSeen) {
        state = { ...state, bluetoothConnected: false, targetSeen, error: "Bonded device is not currently discoverable/connectable" };
        log("audio.result", { ...state });
        return state;
      }
    }

    let connectError: string | undefined;
    log("audio.reconnect", { phase: "a2dp", uuid: A2DP_SINK_UUID });
    await bluez.connect(mac, A2DP_SINK_UUID, 30_000).catch(error => {
      connectError = String(error);
      log("audio.a2dp-connect", { error: connectError });
    });
    await this.waitBluetooth(bluez, mac, true, 10);
    state = await this.wait(mac, 15);
    bluetooth = await bluez.info(mac);

    if (bluetooth.connected && !state.cardFound) {
      log("audio.reconnect", { phase: "wireplumber" });
      await bluez.restartWireplumber();
      state = await this.wait(mac, 10);
    }
    if (state.cardFound && !state.sinkFound) {
      await this.activateA2dp(state);
      state = await this.wait(mac, 5);
    }
    bluetooth = await bluez.info(mac);
    state = { ...state, bluetoothConnected: bluetooth.connected, targetSeen, error: state.error ?? connectError };
    log("audio.result", { ...state });
    return state;
  }
}
