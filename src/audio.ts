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

function macNeedles(mac: string): string[] {
  const lower = mac.toLowerCase();
  const underscore = lower.replaceAll(":", "_");
  const tail = lower.split(":").slice(1).join(":");
  const tailUnderscore = tail.replaceAll(":", "_");
  return [...new Set([lower, underscore, tail, tailUnderscore].filter(Boolean))];
}

export class AudioManager {
  protected async pactlJson(kind: "cards" | "sinks"): Promise<{ data: JsonObject[]; error?: string }> {
    if (!await commandExists("pactl")) return { data: [], error: "pactl is missing" };
    const result = await run(["pactl", "-f", "json", "list", kind], { allowFailure: true, timeoutMs: 10_000 });
    if (result.exitCode !== 0) return { data: [], error: (result.stderr || result.stdout).trim() };
    try { return { data: objects(JSON.parse(result.stdout)) }; }
    catch { return { data: [], error: `Invalid pactl JSON for ${kind}` }; }
  }

  async state(mac: string): Promise<AudioState> {
    const needles = macNeedles(mac);
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

  protected async wait(mac: string, seconds: number): Promise<AudioState> {
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

  async setDefaultSink(sinkName: string): Promise<void> {
    if (!await commandExists("pactl")) return;
    log("audio.set-default-sink", { sinkName });
    await run(["pactl", "set-default-sink", sinkName], { allowFailure: true, timeoutMs: 8_000 });
  }

  async rerouteAudioStreams(sinkName: string): Promise<void> {
    if (!await commandExists("pactl")) return;
    const result = await run(["pactl", "-f", "json", "list", "sink-inputs"], { allowFailure: true, timeoutMs: 8_000 });
    if (result.exitCode !== 0) return;
    try {
      const inputs = JSON.parse(result.stdout);
      if (Array.isArray(inputs)) {
        for (const input of inputs) {
          const index = input?.index;
          if (index !== undefined) {
            log("audio.reroute-stream", { index, toSink: sinkName });
            await run(["pactl", "move-sink-input", String(index), sinkName], { allowFailure: true, timeoutMs: 5_000 });
          }
        }
      }
    } catch (e) {
      log("audio.reroute.failed", { error: String(e) });
    }
  }

  async postConnectReconcile(sinkName: string): Promise<void> {
    await this.setDefaultSink(sinkName);
    await this.rerouteAudioStreams(sinkName);
  }

  async cycleCardProfile(cardName: string, state: AudioState): Promise<void> {
    if (!await commandExists("pactl")) return;
    log("audio.cycle-profile", { cardName });
    await run(["pactl", "set-card-profile", cardName, "off"], { allowFailure: true, timeoutMs: 8_000 });
    await Bun.sleep(1_000);
    // Fallback to standard SBC codec profile if available to ensure audio stability under interference
    const sbcProfile = state.availableProfiles.find(name => /sbc/i.test(name));
    const profile = sbcProfile || state.availableProfiles.find(name => /^a2dp-sink(?:-|$)/.test(name));
    if (profile) {
      await run(["pactl", "set-card-profile", cardName, profile], { allowFailure: true, timeoutMs: 8_000 });
    }
  }

  protected async waitBluetooth(bluez: Bluez, mac: string, connected: boolean, seconds: number): Promise<boolean> {
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
    if (state.sinkFound && state.sinkName) {
      await this.postConnectReconcile(state.sinkName);
      return state;
    }

    if (state.cardFound) {
      await this.activateA2dp(state);
      state = await this.wait(mac, 5);
      if (state.sinkFound && state.sinkName) {
        await this.postConnectReconcile(state.sinkName);
        return state;
      }
    }

    if (!state.serverAvailable) await bluez.restartAudio();

    let targetSeen: boolean | undefined;
    bluetooth = await bluez.info(mac);
    if (!bluetooth.connected) {
      log("audio.scan", { mode: "bredr", seconds: 10 });
      const devices = await bluez.scan("bredr", 10);
      targetSeen = devices.some(device => device.mac === mac);
      if (!targetSeen) {
        const related = devices.find(device => {
          const deviceTail = device.mac.split(":").slice(1).join(":");
          const macTail = mac.split(":").slice(1).join(":");
          return device.mac !== mac && deviceTail === macTail;
        });
        if (related) {
          log("audio.related-identity", {
            target: mac,
            seen: related.mac,
            name: related.alias ?? related.name,
            message: "Continuing audio recovery because a likely sibling identity is present.",
          });
        } else {
          log("audio.target-not-seen", {
            mac,
            message: "Target was not seen in discovery, but audio recovery will still try a direct profile connect because paired Classic devices may be page-connectable without advertising.",
          });
        }
      }
    }

    let connectError: string | undefined;
    let defaultConnectError: string | undefined;
    log("audio.reconnect", { phase: "default" });
    await bluez.connect(mac, undefined, 15_000).catch(error => {
      defaultConnectError = String(error);
      log("audio.default-connect", { error: defaultConnectError });
    });

    log("audio.reconnect", { phase: "a2dp", uuid: A2DP_SINK_UUID });
    
    // Ensure the device is trusted to prevent BlueZ from rejecting the profile connection
    bluetooth = await bluez.info(mac);
    if (!bluetooth.trusted && typeof bluez.trust === "function") {
      log("audio.trust", { mac });
      await bluez.trust(mac).catch(error => log("trust.failed", { error: String(error) }));
    }
    
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
    if (bluetooth.connected && !state.cardFound) {
      log("audio.reconnect", { phase: "profile-reset", message: "BlueZ ACL is connected but PipeWire has no card; resetting the audio profile connection." });
      if (typeof bluez.disconnect === "function") {
        await bluez.disconnect(mac).catch(error => log("audio.disconnect", { error: String(error) }));
      }
      await Bun.sleep(2_000);
      const resetScan = typeof bluez.scan === "function"
        ? await bluez.scan("bredr", 6).catch(error => {
          log("audio.reset-scan", { error: String(error) });
          return [];
        })
        : [];
      log("audio.reset-scan", {
        targetSeen: resetScan.some(device => device.mac === mac),
        devices: resetScan.length,
      });
      if (typeof bluez.trust === "function") {
        await bluez.trust(mac).catch(error => log("audio.trust", { error: String(error) }));
      }
      await bluez.connect(mac, undefined, 25_000).catch(error => {
        defaultConnectError = String(error);
        log("audio.default-reconnect", { error: defaultConnectError });
      });
      await this.waitBluetooth(bluez, mac, true, 8);
      state = await this.wait(mac, 8);
      bluetooth = await bluez.info(mac);
    }
    if (bluetooth.connected && !state.cardFound) {
      await bluez.connect(mac, A2DP_SINK_UUID, 30_000).catch(error => {
        connectError = String(error);
        log("audio.a2dp-reconnect", { error: connectError });
      });
      await this.waitBluetooth(bluez, mac, true, 10);
      state = await this.wait(mac, 15);
      bluetooth = await bluez.info(mac);
    }
    if (bluetooth.connected && !state.cardFound) {
      log("audio.reconnect", { phase: "wireplumber-after-profile-reset" });
      await bluez.restartWireplumber();
      state = await this.wait(mac, 10);
    }
    if (state.cardFound && !state.sinkFound) {
      log("audio.reconnect", { phase: "profile-cycle" });
      await this.cycleCardProfile(state.cardName!, state);
      state = await this.wait(mac, 5);
    }
    if (state.cardFound && !state.sinkFound) {
      await this.activateA2dp(state);
      state = await this.wait(mac, 5);
    }
    if (state.sinkFound && state.sinkName) {
      await this.postConnectReconcile(state.sinkName);
    }
    bluetooth = await bluez.info(mac);
    state = {
      ...state,
      bluetoothConnected: bluetooth.connected,
      targetSeen,
      error: state.sinkFound ? undefined : state.error ?? connectError ?? defaultConnectError,
    };
    log("audio.result", { ...state });
    return state;
  }
}
