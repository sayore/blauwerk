export type ScenarioStatus = "handled" | "partial" | "planned" | "manual";
export type ScenarioCategory =
  | "discovery"
  | "pairing"
  | "connection"
  | "audio"
  | "input"
  | "specialized"
  | "host"
  | "platform";

export interface FailureScenario {
  id: string;
  title: string;
  category: ScenarioCategory;
  status: ScenarioStatus;
  observe: string;
  guidance: string;
  verify: string;
}

type ScenarioSeed = readonly [status: ScenarioStatus, title: string];

const playbooks: Record<ScenarioCategory, Pick<FailureScenario, "observe" | "guidance" | "verify">> = {
  discovery: {
    observe: "Inventory adapters, bearers, discovery events, identity data and signal history.",
    guidance: "Preserve known state, try only supported bearers, and explain any required device-side discovery action.",
    verify: "The intended physical device is identified consistently and remains reachable after discovery stops.",
  },
  pairing: {
    observe: "Track agent callbacks, BlueZ security state, link-key persistence and the terminal error class.",
    guidance: "Use the least-privileged compatible agent, reconcile late success, and avoid silent security downgrades.",
    verify: "Pairing survives reconnect or is explicitly reported as a session-only limitation.",
  },
  connection: {
    observe: "Track the ACL, bearer, resolved services, profile operations, retries and disconnect reasons.",
    guidance: "Serialize operations, apply bounded backoff, and connect only profiles required by the selected intent.",
    verify: "The required profile is active, not merely the low-level Bluetooth link.",
  },
  audio: {
    observe: "Compare BlueZ services with PipeWire cards, profiles, nodes, codecs, routes and active-session ownership.",
    guidance: "Reconcile the BlueZ transport and WirePlumber graph, then prefer a standards-based codec fallback.",
    verify: "The requested playback or capture node exists and can be selected by applications.",
  },
  input: {
    observe: "Compare the Bluetooth HID state with kernel drivers, evdev/hidraw nodes, permissions and input capabilities.",
    guidance: "Keep the adapter awake, identify missing driver or permission layers, and expose device-firmware limits.",
    verify: "Expected buttons, axes, keys, force feedback or wake behavior produce observable kernel input events.",
  },
  specialized: {
    observe: "Resolve GATT and specialized profile services, security requirements, kernel/user-space nodes and protocol errors.",
    guidance: "State the required service and security level, then hand proprietary protocols to an explicit plugin boundary.",
    verify: "The intent-specific GATT, MIDI, network or transfer operation completes successfully.",
  },
  host: {
    observe: "Capture controller, USB power, firmware, kernel, service, session, permissions and journal state.",
    guidance: "Offer a narrow reversible host change, retain a rollback path, and distinguish hardware from software faults.",
    verify: "The controller and required user service remain healthy across reconnect and, where relevant, suspend/resume.",
  },
  platform: {
    observe: "Negotiate backend capabilities before attempting discovery, pairing, profile or optimization operations.",
    guidance: "Use a native backend or explain the platform boundary instead of emulating success.",
    verify: "The backend explicitly reports whether the requested intent is working, limited or unsupported.",
  },
};

const seeds: Record<ScenarioCategory, readonly ScenarioSeed[]> = {
  discovery: [
    ["handled", "Controller is powered off"],
    ["handled", "rfkill / airplane mode"],
    ["planned", "Wrong default adapter"],
    ["planned", "Adapter lacks BR/EDR or LE"],
    ["handled", "Device is not advertising"],
    ["partial", "Device is connectable but not discoverable"],
    ["handled", "Duplicate Classic and LE identities"],
    ["planned", "Rotating BLE private address"],
    ["partial", "Multiple devices share a name"],
    ["handled", "Unknown device name"],
    ["partial", "Scan filter misses passive advertisements"],
    ["partial", "Weak or unstable signal"],
    ["planned", "2.4 GHz / USB 3 interference"],
    ["partial", "Device changes identity after factory reset"],
    ["planned", "Device already connected to another host"],
    ["planned", "Multipoint slots are full"],
  ],
  pairing: [
    ["partial", "No pairing agent"],
    ["partial", "Wrong I/O capability"],
    ["handled", "Numeric confirmation required"],
    ["handled", "Passkey must be entered on host"],
    ["handled", "Passkey must be typed on device"],
    ["planned", "Legacy PIN (0000, 1234)"],
    ["handled", "Pairing already in progress"],
    ["handled", "CLI timeout but BlueZ succeeded"],
    ["handled", "Authentication rejected"],
    ["partial", "Authentication timeout"],
    ["handled", "Stale host-side link key"],
    ["manual", "Stale device-side link key"],
    ["handled", "Device bond table is full"],
    ["handled", "Paired but not bonded"],
    ["handled", "Bond exists but device is untrusted"],
    ["handled", "Blocked device"],
    ["planned", "Secure Connections incompatibility"],
    ["planned", "CTKD / dual-bearer key mismatch"],
    ["manual", "OOB/NFC pairing required"],
    ["partial", "Profile authorization required"],
  ],
  connection: [
    ["handled", "ACL connected but no usable profile"],
    ["partial", "Connect operation still pending"],
    ["partial", "Command times out after success"],
    ["partial", "Wrong bearer selected on dual-mode device"],
    ["handled", "Profile direction confusion"],
    ["handled", "Device exposes only a subset of profiles"],
    ["handled", "Service discovery is slow"],
    ["partial", "Service discovery never completes"],
    ["partial", "Remote terminates link"],
    ["partial", "Kernel/controller page timeout"],
    ["partial", "Connection retries make state worse"],
    ["handled", "Another Bluetooth manager competes"],
    ["partial", "Device firmware crashes under parallel profiles"],
  ],
  audio: [
    ["handled", "PipeWire server unavailable"],
    ["partial", "WirePlumber BlueZ monitor missing"],
    ["handled", "bluez_card missing"],
    ["handled", "Card exists but output sink is missing"],
    ["handled", "A2DP transport Acquire fails"],
    ["partial", "Transport is busy"],
    ["planned", "No common codec"],
    ["planned", "High-quality codec is unstable"],
    ["planned", "LE Audio device lacks BAP support"],
    ["planned", "Headset supports music but no microphone"],
    ["planned", "HFP/HSP backend missing"],
    ["planned", "Microphone use downgrades music quality"],
    ["planned", "Absolute volume is broken"],
    ["partial", "Sink exists but desktop UI omits it"],
    ["handled", "Application stays on old sink"],
    ["handled", "Wrong default output"],
    ["planned", "Codec latency is poor for gaming"],
    ["partial", "Audio device is both Sink and Source"],
  ],
  input: [
    ["handled", "USB Bluetooth adapter autosuspends"],
    ["planned", "Gamepad sleeps from its own firmware"],
    ["planned", "Host idle policy disconnects HID"],
    ["planned", "HID connects but creates no input node"],
    ["planned", "hidraw permission denied"],
    ["planned", "Wrong kernel HID driver"],
    ["planned", "Rumble/force feedback unavailable"],
    ["planned", "Gyro/touchpad unavailable"],
    ["planned", "SDL/Steam mapping missing"],
    ["planned", "Nintendo/PlayStation/Xbox quirks"],
    ["planned", "Keyboard needs secure passkey entry"],
    ["planned", "Input device should wake system"],
    ["planned", "Battery level unavailable"],
    ["planned", "Controller has audio endpoints"],
  ],
  specialized: [
    ["partial", "GATT services resolve slowly"],
    ["planned", "Required GATT service is absent"],
    ["planned", "Characteristic requires encryption"],
    ["planned", "Characteristic requires authorization"],
    ["planned", "MTU is too small for operation"],
    ["planned", "BLE connection interval favors battery over latency"],
    ["planned", "Notification subscription fails"],
    ["planned", "BLE MIDI node missing"],
    ["planned", "PAN/network profile missing"],
    ["planned", "OBEX/file transfer unavailable"],
    ["manual", "Proprietary vendor protocol"],
  ],
  host: [
    ["partial", "Broken/fake USB controller"],
    ["planned", "Missing controller firmware"],
    ["planned", "USB hub power instability"],
    ["partial", "Resume leaves HCI stuck"],
    ["handled", "Invalid BlueZ config"],
    ["planned", "Kernel regression"],
    ["handled", "PulseAudio and PipeWire conflict"],
    ["planned", "No user D-Bus/session"],
    ["planned", "Flatpak/container blocks Bluetooth or audio"],
    ["partial", "Polkit/sudo unavailable"],
    ["planned", "Multiple users/seats compete for Bluetooth audio"],
  ],
  platform: [
    ["planned", "Platform has no BlueZ"],
    ["planned", "macOS exposes BLE but restricts generic Classic management"],
    ["planned", "Windows pairing requires OS consent UI"],
    ["planned", "Different platforms expose different profile state"],
    ["planned", "A platform cannot apply a requested optimization"],
  ],
};

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export const failureScenarios: readonly FailureScenario[] = Object.entries(seeds).flatMap(([category, entries]) =>
  entries.map(([status, title]) => ({
    id: slug(title),
    title,
    category: category as ScenarioCategory,
    status,
    ...playbooks[category as ScenarioCategory],
  })),
);

export function scenarioCoverage(): {
  total: number;
  guidance: number;
  handled: number;
  partial: number;
  planned: number;
  manual: number;
  byCategory: Record<ScenarioCategory, number>;
} {
  const byCategory = Object.fromEntries(Object.keys(seeds).map(category => [category, 0])) as Record<ScenarioCategory, number>;
  const result = { total: failureScenarios.length, guidance: 0, handled: 0, partial: 0, planned: 0, manual: 0, byCategory };
  for (const scenario of failureScenarios) {
    result[scenario.status]++;
    if (scenario.observe && scenario.guidance && scenario.verify) result.guidance++;
    result.byCategory[scenario.category]++;
  }
  return result;
}
