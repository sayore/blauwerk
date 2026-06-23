import { readdirSync, readFileSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import { capabilities } from "./catalog";
import type { ConfigIssue } from "./config";
import type { AdapterPowerState } from "./power";
import type { AudioState, DeviceState } from "./types";

export type NoticeSeverity = "info" | "warning" | "error";

export interface DeviceNotice {
  id: string;
  severity: NoticeSeverity;
  title: string;
  detail: string;
  command?: string;
}

export function adviseDevice(
  device: DeviceState,
  context: { audio?: AudioState; power?: AdapterPowerState; configIssues?: ConfigIssue[] } = {},
): DeviceNotice[] {
  const notices: DeviceNotice[] = [];
  const add = (notice: DeviceNotice) => notices.push(notice);
  const caps = capabilities(device);

  if (device.blocked) add({
    id: "blocked", severity: "error", title: "Device is blocked",
    detail: "BlueZ will reject connection attempts until the device is unblocked.",
    command: `bluetoothctl unblock ${device.mac}`,
  });
  if (device.paired && device.bonded === false) add({
    id: "not-bonded", severity: "warning", title: "Pairing is not persistent",
    detail: "The current session may work, but the remote did not persist a reusable link key.",
    command: `blauwerk doctor --mac ${device.mac} --require-bond`,
  });
  if (device.paired && !device.trusted) add({
    id: "not-trusted", severity: "warning", title: "Paired device is not trusted",
    detail: "Automatic profile connections may require authorization after every reconnect.",
    command: `blauwerk connect ${device.mac}`,
  });
  if (device.connected && device.uuids.length === 0) add({
    id: "services-missing", severity: "warning", title: "Services are not resolved",
    detail: "The low-level link exists, but BlueZ has not exposed usable services yet.",
    command: `blauwerk doctor --mac ${device.mac}`,
  });
  if (!device.paired && device.servicesResolved !== true) add({
    id: "capabilities-pending", severity: "info", title: "Capabilities may be incomplete before pairing",
    detail: "Many Classic devices reveal their complete SDP profile list only after pairing and service discovery. Blauwerk will classify the device again after connecting.",
  });
  if (device.addressType === "random" && !device.paired) add({
    id: "private-address", severity: "info", title: "Private BLE address",
    detail: "This address may rotate. Future identity tracking should use advertisement fingerprints instead of only the MAC.",
  });
  if (device.rssi !== undefined && device.rssi < -80) add({
    id: "weak-signal", severity: "warning", title: `Weak signal (${device.rssi} dBm)`,
    detail: "Pairing and profile negotiation may fail intermittently. Move the device closer and avoid USB 3 / 2.4 GHz interference.",
  });
  if (device.rssi !== undefined && device.rssi < -75) add({
    id: "rf-interference", severity: "warning", title: `Moderate to poor signal (${device.rssi} dBm)`,
    detail: "High probability of 2.4 GHz spectrum crowding or USB 3.0 controller port interference. Consider using a USB extension cable for your Bluetooth dongle to isolate it from host USB 3.0 ports.",
  });
  if (device.legacyPairing) add({
    id: "legacy-pairing", severity: "info", title: "Legacy PIN pairing",
    detail: "This device may require a fixed PIN such as 0000 or 1234 and a different pairing agent.",
  });
  if (device.connected && (caps.audioSink || caps.audioSource) && context.audio && !context.audio.cardFound) add({
    id: "audio-card-missing", severity: "warning", title: "Bluetooth audio card is missing",
    detail: "BlueZ is connected, but WirePlumber/PipeWire did not retain a matching bluez_card.",
    command: `blauwerk audio ${device.mac} --fix`,
  });
  if (context.audio?.cardFound && !context.audio.sinkFound && caps.audioSink) add({
    id: "audio-sink-missing", severity: "warning", title: "Audio output profile is inactive",
    detail: "The PipeWire card exists, but no playback sink is available.",
    command: `blauwerk audio ${device.mac} --fix`,
  });
  if (context.power?.control === "auto") add({
    id: "adapter-autosuspend", severity: "warning", title: "Bluetooth adapter may autosuspend",
    detail: `USB runtime power management may suspend the adapter after ${context.power.autosuspendDelayMs ?? "an unknown delay"} ms. This is especially risky for gamepads and long profile negotiation.`,
    command: "blauwerk power --fix",
  });
  for (const issue of context.configIssues ?? []) add({
    id: `config-${issue.section}-${issue.key}`, severity: issue.severity,
    title: `BlueZ setting ${issue.key} is ${issue.severity === "error" ? "invalid" : "risky"}`,
    detail: `[${issue.section}] ${issue.key}=${issue.value}: ${issue.message}`,
    command: "blauwerk config --fix",
  });
  if (device.connected && !caps.labels.length) add({
    id: "unknown-capabilities", severity: "info", title: "No known capability profile",
    detail: "The device may use BLE GATT or a proprietary vendor protocol that Blauwerk cannot verify yet.",
  });

  // Check LE Audio BAP support
  const hasLEAudioPACS = device.uuids.some(uuid => uuid.startsWith("00001850-"));
  const hasLEAudioBAP = device.uuids.some(uuid => uuid.startsWith("0000184e-"));
  if (hasLEAudioPACS && !hasLEAudioBAP) add({
    id: "le-audio-bap-missing", severity: "warning", title: "LE Audio BAP support is missing",
    detail: "This device advertises LE Audio capabilities (PACS) but lacks BAP support (ASCS), which is required for streaming audio.",
  });

  // Check A2DP vs HFP/HSP (music vs call intent)
  const hasA2DP = caps.audioSink;
  const supportsHfpHsp = device.uuids.some(uuid => /111e|111f|1108|1112/i.test(uuid));
  if (hasA2DP && !supportsHfpHsp) add({
    id: "headset-no-microphone", severity: "info", title: "Headset lacks microphone profile",
    detail: "This device supports high-quality music playback (A2DP) but does not expose any microphone profile (HFP/HSP). Two-way calls will use the host microphone.",
  });

  // Check WirePlumber HFP/HSP backend missing
  if (context.audio?.cardFound && supportsHfpHsp) {
    const hasHfpProfile = context.audio.availableProfiles.some(profile => /headset|handsfree|hfp|hsp/i.test(profile));
    if (!hasHfpProfile) add({
      id: "hfp-backend-missing", severity: "warning", title: "HFP/HSP audio backend is missing",
      detail: "The headset supports calls, but no call profiles (HFP/HSP) are exposed in WirePlumber. Check if wireplumber native HFP or oFono is installed.",
    });
  }

  // Check gamepad/input device sleep warnings
  if (!device.connected && caps.humanInterface && device.paired) add({
    id: "gamepad-idle-sleep", severity: "info", title: "Input device is disconnected",
    detail: "Gamepads and keyboards often shut down automatically to save battery. Press a button on the device to wake it and trigger auto-reconnect.",
  });

  // Check hidraw read/write permissions
  if (device.connected && caps.humanInterface) {
    try {
      const hidraws = readdirSync("/sys/class/hidraw");
      let matchedNode: string | undefined = undefined;
      const normalizedMac = device.mac.toLowerCase();
      for (const node of hidraws) {
        const ueventPath = join("/sys/class/hidraw", node, "device", "uevent");
        try {
          const content = readFileSync(ueventPath, "utf8").toLowerCase();
          if (content.includes(normalizedMac) || content.includes(normalizedMac.replaceAll(":", ""))) {
            matchedNode = node;
            break;
          }
        } catch {}
      }
      if (matchedNode) {
        const devPath = join("/dev", matchedNode);
        try {
          accessSync(devPath, constants.R_OK | constants.W_OK);
        } catch {
          add({
            id: "hidraw-permission-denied", severity: "error", title: `Read/write permissions denied for ${devPath}`,
            detail: `Your user cannot access the input device node ${devPath}. Custom controllers/gamepads may fail to report rumble or special buttons.`,
            command: `echo 'KERNEL=="${matchedNode}", GROUP="input", MODE="0660"' | sudo tee /etc/udev/rules.d/99-blauwerk-hid.rules && sudo udevadm trigger`,
          });
        }
      }
    } catch {}
  }

  return notices;
}
