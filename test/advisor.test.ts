import { describe, expect, test } from "bun:test";
import { adviseDevice } from "../src/advisor";
import type { DeviceState } from "../src/types";

const device = (overrides: Partial<DeviceState> = {}): DeviceState => ({
  mac: "AA:BB:CC:DD:EE:FF", available: true, paired: true, bonded: true,
  trusted: true, blocked: false, connected: false, uuids: [], raw: "", ...overrides,
});

describe("device advisor", () => {
  test("reports actionable bond and power settings", () => {
    const notices = adviseDevice(device({ bonded: false }), {
      power: { path: "/sys/device", control: "auto", autosuspendDelayMs: 2_000 },
    });
    expect(notices.map(notice => notice.id)).toContain("not-bonded");
    expect(notices.map(notice => notice.id)).toContain("adapter-autosuspend");
    expect(notices.every(notice => notice.detail.length > 0)).toBeTrue();
  });

  test("reports a missing audio card only for an audio device", () => {
    const notices = adviseDevice(device({ connected: true, uuids: ["Audio Sink (0000110b-0000-1000-8000-00805f9b34fb)"] }), {
      audio: { serverAvailable: true, cardFound: false, sinkFound: false, availableProfiles: [] },
    });
    expect(notices.map(notice => notice.id)).toContain("audio-card-missing");
  });

  test("reports a stuck A2DP profile connection separately from missing sink", () => {
    const notices = adviseDevice(device({ connected: true, uuids: ["Audio Sink (0000110b-0000-1000-8000-00805f9b34fb)"] }), {
      audio: {
        serverAvailable: true,
        cardFound: false,
        sinkFound: false,
        availableProfiles: [],
        error: "Error: Failed to connect: org.bluez.Error.InProgress br-connection-busy",
      },
    });
    expect(notices.map(notice => notice.id)).toContain("audio-profile-connect-busy");
  });

  test("reports missing btusb and stuck controller host states", () => {
    const notices = adviseDevice(device(), {
      host: {
        controllerAvailable: false,
        powerState: "on-disabling",
        powerTransitionStuck: true,
        btusbLoaded: false,
        competingManagers: [],
        backgroundScannerActive: false,
      },
    });
    expect(notices.map(notice => notice.id)).toContain("bluetooth-controller-driver-missing");
    expect(notices.map(notice => notice.id)).toContain("bluetooth-controller-power-stuck");
  });

  test("reports active background scanner during discovery", () => {
    const notices = adviseDevice(device(), {
      host: {
        controllerAvailable: true,
        discovering: true,
        btusbLoaded: true,
        competingManagers: ["941 /usr/bin/bun run src/cli.ts daemon --run"],
        backgroundScannerActive: true,
      },
    });
    expect(notices.map(notice => notice.id)).toContain("bluetooth-background-scan-active");
  });

  test("explains that discovery-time capabilities may be incomplete", () => {
    const notices = adviseDevice(device({ paired: false, bonded: false, uuids: ["Vendor (12345678-1234-5678-1234-567812345678)"] }));
    expect(notices.map(notice => notice.id)).toContain("capabilities-pending");
  });

  test("warns about moderate to poor signal RF/USB 3.0 interference", () => {
    const notices = adviseDevice(device({ rssi: -78 }));
    expect(notices.map(notice => notice.id)).toContain("rf-interference");
  });

  test("warns when LE Audio PACS is present but BAP is missing", () => {
    const notices = adviseDevice(device({ uuids: ["00001850-0000-1000-8000-00805f9b34fb"] })); // PACS only
    expect(notices.map(notice => notice.id)).toContain("le-audio-bap-missing");
  });

  test("warns when audio headset supports music but has no call/microphone UUIDs", () => {
    const notices = adviseDevice(device({ uuids: ["0000110b-0000-1000-8000-00805f9b34fb"] })); // Audio Sink (A2DP)
    expect(notices.map(notice => notice.id)).toContain("headset-no-microphone");
  });

  test("warns when HFP backend is missing in WirePlumber", () => {
    const notices = adviseDevice(
      device({ connected: true, uuids: ["0000110b-0000-1000-8000-00805f9b34fb", "0000111e-0000-1000-8000-00805f9b34fb"] }), // Sink + Handsfree
      { audio: { serverAvailable: true, cardFound: true, sinkFound: true, availableProfiles: ["a2dp-sink"] } } // lacks headset profile
    );
    expect(notices.map(notice => notice.id)).toContain("hfp-backend-missing");
  });

  test("notifies when a paired gamepad is disconnected", () => {
    const notices = adviseDevice(device({ connected: false, paired: true, uuids: ["00001124-0000-1000-8000-00805f9b34fb"] })); // HID profile
    expect(notices.map(notice => notice.id)).toContain("gamepad-idle-sleep");
  });

  test("triggers blocked error notice", () => {
    const notices = adviseDevice(device({ blocked: true }));
    expect(notices.map(n => n.id)).toContain("blocked");
  });

  test("triggers not-bonded warning notice", () => {
    const notices = adviseDevice(device({ paired: true, bonded: false }));
    expect(notices.map(n => n.id)).toContain("not-bonded");
  });

  test("triggers not-trusted warning notice", () => {
    const notices = adviseDevice(device({ paired: true, trusted: false }));
    expect(notices.map(n => n.id)).toContain("not-trusted");
  });

  test("triggers services-missing warning notice", () => {
    const notices = adviseDevice(device({ connected: true, uuids: [] }));
    expect(notices.map(n => n.id)).toContain("services-missing");
  });

  test("triggers private-address info notice", () => {
    const notices = adviseDevice(device({ addressType: "random", paired: false }));
    expect(notices.map(n => n.id)).toContain("private-address");
  });

  test("triggers weak-signal warning notice", () => {
    const notices = adviseDevice(device({ rssi: -82 }));
    expect(notices.map(n => n.id)).toContain("weak-signal");
  });

  test("triggers legacy-pairing info notice", () => {
    const notices = adviseDevice(device({ legacyPairing: true }));
    expect(notices.map(n => n.id)).toContain("legacy-pairing");
  });

  test("triggers missing audio card warning notice", () => {
    const notices = adviseDevice(
      device({ connected: true, uuids: ["0000110b-0000-1000-8000-00805f9b34fb"] }), // Sink
      { audio: { serverAvailable: true, cardFound: false, sinkFound: false, availableProfiles: [] } }
    );
    expect(notices.map(n => n.id)).toContain("audio-card-missing");
  });

  test("triggers missing audio sink warning notice", () => {
    const notices = adviseDevice(
      device({ connected: true, uuids: ["0000110b-0000-1000-8000-00805f9b34fb"] }),
      { audio: { serverAvailable: true, cardFound: true, sinkFound: false, availableProfiles: [] } }
    );
    expect(notices.map(n => n.id)).toContain("audio-sink-missing");
  });

  test("triggers adapter-autosuspend warning notice", () => {
    const notices = adviseDevice(device(), {
      power: { path: "/sys/class", control: "auto", autosuspendDelayMs: 2_000 }
    });
    expect(notices.map(n => n.id)).toContain("adapter-autosuspend");
  });

  test("triggers config issues warnings and errors", () => {
    const notices = adviseDevice(device(), {
      configIssues: [{ section: "General", key: "IdleTimeout", value: "0", severity: "error", message: "invalid" }]
    });
    expect(notices.map(n => n.id)).toContain("config-General-IdleTimeout");
  });

  test("triggers unknown-capabilities info notice", () => {
    const notices = adviseDevice(device({ connected: true, uuids: [] }));
    expect(notices.map(n => n.id)).toContain("unknown-capabilities");
  });
});
