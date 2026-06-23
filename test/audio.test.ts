import { describe, expect, test, mock, beforeEach } from "bun:test";

let runMock = (...args: any[]): Promise<any> => Promise.resolve({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
let commandExistsMock = (...args: any[]): Promise<boolean> => Promise.resolve(true);

mock.module("../src/process", () => ({
  run: (...args: any[]) => runMock(...args),
  commandExists: (...args: any[]) => commandExistsMock(...args),
}));

import { AudioManager } from "../src/audio";
import { Bluez } from "../src/bluez";

class MockAudioManager extends AudioManager {
  constructor(
    private mockCards: any[] = [],
    private mockSinks: any[] = []
  ) {
    super();
  }

  public useBasePactlJson = false;

  protected override async pactlJson(kind: "cards" | "sinks") {
    if (this.useBasePactlJson) {
      return super.pactlJson(kind);
    }
    return {
      data: kind === "cards" ? this.mockCards : this.mockSinks,
    };
  }

  protected override async wait(mac: string, seconds: number) {
    return this.state(mac);
  }

  protected override async waitBluetooth(bluez: any, mac: string, connected: boolean, seconds: number) {
    return true;
  }
}

describe("audio identity", () => {
  test("normalizes a Bluetooth MAC to the bluez object suffix", () => {
    expect("AC:B1:EE:71:A1:51".replaceAll(":", "_").toLowerCase()).toBe("ac_b1_ee_71_a1_51");
  });
});

describe("AudioManager", () => {
  beforeEach(() => {
    runMock = (...args: any[]): Promise<any> => Promise.resolve({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
    commandExistsMock = (...args: any[]): Promise<boolean> => Promise.resolve(true);
  });

  test("correctly parses card and sink state from pactl details", async () => {
    const mockCards = [
      {
        name: "bluez_card.ac_b1_ee_71_a1_51",
        active_profile: "a2dp-sink",
        profiles: [
          { name: "off", available: "yes" },
          { name: "a2dp-sink", available: "yes" }
        ]
      }
    ];
    const mockSinks = [
      {
        name: "bluez_output.ac_b1_ee_71_a1_51.a2dp-sink",
        active_profile: "a2dp-sink"
      }
    ];

    const manager = new MockAudioManager(mockCards, mockSinks);
    const state = await manager.state("AC:B1:EE:71:A1:51");
    expect(state.cardFound).toBeTrue();
    expect(state.sinkFound).toBeTrue();
    expect(state.cardName).toBe("bluez_card.ac_b1_ee_71_a1_51");
    expect(state.sinkName).toBe("bluez_output.ac_b1_ee_71_a1_51.a2dp-sink");
    expect(state.activeProfile).toBe("a2dp-sink");
    expect(state.availableProfiles).toEqual(["off", "a2dp-sink"]);
  });

  test("handles missing pactl command during state inquiry", async () => {
    commandExistsMock = async () => false;
    const manager = new MockAudioManager();
    manager.useBasePactlJson = true;
    const state = await manager.state("AC:B1:EE:71:A1:51");
    expect(state.serverAvailable).toBeFalse();
    expect(state.error).toBe("pactl is missing");
  });

  test("handles pactl command failure", async () => {
    commandExistsMock = async () => true;
    runMock = async () => ({ exitCode: 1, stderr: "failed to connect", stdout: "" });
    const manager = new MockAudioManager();
    manager.useBasePactlJson = true;
    const state = await manager.state("AC:B1:EE:71:A1:51");
    expect(state.serverAvailable).toBeFalse();
    expect(state.error).toBe("failed to connect");
  });

  test("handles invalid JSON output from pactl", async () => {
    commandExistsMock = async () => true;
    runMock = async () => ({ exitCode: 0, stdout: "not json at all", stderr: "" });
    const manager = new MockAudioManager();
    manager.useBasePactlJson = true;
    const state = await manager.state("AC:B1:EE:71:A1:51");
    expect(state.serverAvailable).toBeFalse();
    expect(state.error).toContain("Invalid pactl JSON");
  });

  test("filters out profiles where available is 'no'", async () => {
    const mockCards = [
      {
        name: "bluez_card.ac_b1_ee_71_a1_51",
        active_profile: "a2dp-sink",
        profiles: [
          { name: "off", available: "yes" },
          { name: "a2dp-sink-sbc", available: "no" },
          { name: "a2dp-sink-ldac", available: "yes" }
        ]
      }
    ];
    const manager = new MockAudioManager(mockCards, []);
    const state = await manager.state("AC:B1:EE:71:A1:51");
    expect(state.availableProfiles).toEqual(["off", "a2dp-sink-ldac"]);
  });

  test("supports active profiles represented as structures with name field", async () => {
    const mockCards = [
      {
        name: "bluez_card.ac_b1_ee_71_a1_51",
        active_profile: { name: "a2dp-sink-aac", description: "AAC" },
        profiles: [{ name: "a2dp-sink-aac", available: "yes" }]
      }
    ];
    const manager = new MockAudioManager(mockCards, []);
    const state = await manager.state("AC:B1:EE:71:A1:51");
    expect(state.activeProfile).toBe("a2dp-sink-aac");
  });

  test("setDefaultSink skips execution when pactl command is missing", async () => {
    commandExistsMock = async () => false;
    let runCalled = false;
    runMock = async (argv) => {
      runCalled = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const manager = new MockAudioManager();
    await manager.setDefaultSink("my-sink");
    expect(runCalled).toBeFalse();
  });

  test("setDefaultSink invokes pactl set-default-sink command", async () => {
    commandExistsMock = async () => true;
    let runArgv: string[] = [];
    runMock = async (argv) => {
      runArgv = argv;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const manager = new MockAudioManager();
    await manager.setDefaultSink("my-sink");
    expect(runArgv).toEqual(["pactl", "set-default-sink", "my-sink"]);
  });

  test("rerouteAudioStreams ignores error and does not throw when pactl fails", async () => {
    commandExistsMock = async () => true;
    runMock = async () => ({ exitCode: 1, stdout: "", stderr: "error" });
    const manager = new MockAudioManager();
    await expect(manager.rerouteAudioStreams("my-sink")).resolves.toBeUndefined();
  });

  test("rerouteAudioStreams queries inputs and moves all available inputs to target sink", async () => {
    commandExistsMock = async () => true;
    let runs: string[][] = [];
    runMock = async (argv) => {
      runs.push(argv);
      if (argv.includes("list") && argv.includes("sink-inputs")) {
        return { exitCode: 0, stdout: JSON.stringify([{ index: 42 }, { index: 99 }]), stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const manager = new MockAudioManager();
    await manager.rerouteAudioStreams("my-sink");
    expect(runs).toContainEqual(["pactl", "-f", "json", "list", "sink-inputs"]);
    expect(runs).toContainEqual(["pactl", "move-sink-input", "42", "my-sink"]);
    expect(runs).toContainEqual(["pactl", "move-sink-input", "99", "my-sink"]);
  });

  test("cycleCardProfile switches profile off and then to sbc/a2dp sink", async () => {
    commandExistsMock = async () => true;
    let runs: string[][] = [];
    runMock = async (argv) => {
      runs.push(argv);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const manager = new MockAudioManager();
    const state = {
      serverAvailable: true,
      cardFound: true,
      sinkFound: false,
      availableProfiles: ["off", "a2dp-sink-sbc", "a2dp-sink-ldac"],
    };
    await manager.cycleCardProfile("my-card", state);
    expect(runs).toContainEqual(["pactl", "set-card-profile", "my-card", "off"]);
    expect(runs).toContainEqual(["pactl", "set-card-profile", "my-card", "a2dp-sink-sbc"]);
  });

  test("ensure performs fast-path post-connection reconciliation if sink is already present", async () => {
    const mockCards = [{ name: "bluez_card.ac_b1_ee_71_a1_51", active_profile: "a2dp-sink" }];
    const mockSinks = [{ name: "bluez_output.ac_b1_ee_71_a1_51.a2dp-sink" }];
    const manager = new MockAudioManager(mockCards, mockSinks);

    let defaultSinkSet = "";
    manager.setDefaultSink = async (name) => { defaultSinkSet = name; };
    manager.rerouteAudioStreams = async () => {};

    const mockBluez = {
      info: async () => ({ connected: true, servicesResolved: true, uuids: ["0000110b-0000-1000-8000-00805f9b34fb"] })
    } as any;

    const state = await manager.ensure(mockBluez, "AC:B1:EE:71:A1:51");
    expect(state.sinkFound).toBeTrue();
    expect(defaultSinkSet).toBe("bluez_output.ac_b1_ee_71_a1_51.a2dp-sink");
  });

  test("ensure triggers Bluetooth audio server restart if pactl server is down", async () => {
    const manager = new MockAudioManager();
    // Simulate error
    manager.useBasePactlJson = false;
    (manager as any).pactlJson = async () => ({ data: [], error: "Connection refused" });

    let audioRestarted = false;
    const mockBluez = {
      info: async () => ({ connected: true, servicesResolved: true, uuids: ["0000110b-0000-1000-8000-00805f9b34fb"] }),
      restartAudio: async () => { audioRestarted = true; },
      scan: async () => [],
      connect: async () => {},
      restartWireplumber: async () => {},
    } as any;

    await manager.ensure(mockBluez, "AC:B1:EE:71:A1:51");
    expect(audioRestarted).toBeTrue();
  });

  test("ensure scans and fails if target MAC is not discoverable", async () => {
    const manager = new MockAudioManager();
    const mockBluez = {
      info: async () => ({ connected: false, servicesResolved: false, uuids: [] }),
      scan: async () => [{ mac: "FF:FF:FF:FF:FF:FF" }],
    } as any;

    const state = await manager.ensure(mockBluez, "AC:B1:EE:71:A1:51");
    expect(state.bluetoothConnected).toBeFalse();
    expect(state.targetSeen).toBeFalse();
    expect(state.error).toBe("Bonded device is not currently discoverable/connectable");
  });

  test("ensure triggers wireplumber restart if card is missing after connect", async () => {
    const manager = new MockAudioManager([], []);

    let wireplumberRestarted = false;
    const mockBluez = {
      info: async () => ({ connected: true, servicesResolved: true, uuids: ["0000110b-0000-1000-8000-00805f9b34fb"] }),
      connect: async () => {},
      restartWireplumber: async () => { wireplumberRestarted = true; },
    } as any;

    await manager.ensure(mockBluez, "AC:B1:EE:71:A1:51");
    expect(wireplumberRestarted).toBeTrue();
  });

  test("ensure triggers profile cycling if card is present but sink is missing", async () => {
    const mockCards = [{ name: "bluez_card.ac_b1_ee_71_a1_51", active_profile: "off" }];
    const manager = new MockAudioManager(mockCards, []);

    let profileCycled = false;
    const mockBluez = {
      info: async () => ({ connected: true, servicesResolved: true, uuids: ["0000110b-0000-1000-8000-00805f9b34fb"] }),
      connect: async () => {},
      restartWireplumber: async () => {},
    } as any;

    manager.cycleCardProfile = async () => { profileCycled = true; };

    await manager.ensure(mockBluez, "AC:B1:EE:71:A1:51");
    expect(profileCycled).toBeTrue();
  });
});
