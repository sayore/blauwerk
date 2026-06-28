# Blauwerk

Blauwerk is a Bun/TypeScript CLI for inspecting, connecting, and recovering
Bluetooth devices. The current Linux backend integrates BlueZ with
WirePlumber/PipeWire while keeping platform-specific operations behind a small
backend interface.

## Quick Install

Get up and running with a single command (requires no Node/npm/Bun, automatically downloads precompiled native binary):

```bash
curl -fsSL https://raw.githubusercontent.com/sayore/blauwerk/main/install.sh | sh
```

For quick system diagnostics check:
```bash
blauwerk diagnose
```

### Arch Linux / pacman

Arch-based systems can build and install the package with `makepkg`:

```bash
cd packaging/arch
makepkg -si
```

The package builds a native standalone binary from the tagged source release.
Bun is only needed while building; the installed `blauwerk` command does not
need Bun at runtime.


It treats recovery as a convergent state machine: every step re-reads device
state, preserves completed work, and escalates only as far as necessary.

Safety invariants:

- a cached BlueZ device is never treated as proof of a live advertisement;
- a working unbonded session is preserved unless rebonding was explicitly chosen;
- rebonding verifies that the target is pairing-ready before removing ephemeral state;
- discovery stops as soon as the selected target is seen;
- cache purge and controller power cycling remain explicit `--aggressive` actions;
- success is re-read from BlueZ and the intent-specific subsystem after every mutation.

## Input & Media Safety Features

Blauwerk implements specialized, automated safeguards for input (HID) and media (audio) devices to prevent lockouts and connection dropouts:

- **Automatic Input Bonding (HID):** Human Interface Devices (keyboards, mice, gamepads) automatically default to requiring a persistent bond (`--require-bond`). This prevents unstable, ephemeral pairings that fail to auto-reconnect when the device wakes from sleep.
- **Non-Blocking Retry Loop:** When a working input device must be temporarily disconnected to probe for bonding, Blauwerk runs a fully automatic, non-blocking 3-attempt scan loop. Since it requires no keyboard input, you are never locked out of your system while your keyboard is offline.
- **Connection Rollback Retries:** If a device fails to advertise during a rebond attempt, the rollback mechanism automatically retries the connection up to 3 times (with a 2-second delay). This gives the device's radio ample time to wake up and boot, ensuring you are never left stranded in a disconnected state.
- **Media Subsystem Verification:** Reconnecting an audio device automatically triggers downstream verification of PipeWire, WirePlumber, and PulseAudio sinks, restoring active playback streams and cycling cards if the audio server is unresponsive.

### Resolved failure class: desktop says connected, no audio output exists

The Soundcore Boom 2 Pro exposed a common Linux Bluetooth split-brain:

- COSMIC or another desktop panel can show the speaker as connected.
- BlueZ can briefly report `Connected: yes`, or report a connected ACL link
  while profile setup is still busy.
- PipeWire/WirePlumber may still expose no `bluez_card.*` and no
  `bluez_output.*`, so the device cannot be selected as an output.
- Profile connects can fail transiently with errors such as
  `org.bluez.Error.InProgress br-connection-busy`.

Blauwerk now treats this as an audio graph failure, not as a successful
Bluetooth connection. For A2DP playback, success requires a PipeWire sink, not
only `Connected: yes`.

The implemented recovery path:

1. inspect BlueZ state and PipeWire cards/sinks separately;
2. match exact MAC identities and likely sibling Classic/LE identities, for
   example `F4:2B:7D:33:B8:D7` and `CB:2B:7D:33:B8:D7`;
3. continue direct default/A2DP profile connection even when the device is not
   freshly discoverable, because paired Classic devices can still be
   page-connectable;
4. restart WirePlumber when BlueZ has the link but PipeWire has no card;
5. if the ACL link exists without an audio card, perform a serialized profile
   reset: disconnect, short BR/EDR scan, trust, default connect, A2DP connect,
   then re-check PipeWire;
6. when a sink appears, set it as default and move existing playback streams to
   it.

The verified good terminal state is therefore:

```text
bluez_card.<device> exists
bluez_output.<device>.* exists
active profile: a2dp-sink
audio.sinkFound=true
```

### Resolved failure class: device visible in scan, doctor says `targetSeen=false`

`bluetoothctl` does not emit one stable machine format. During interactive
discovery it can prefix events with prompts and ANSI colour sequences, for
example:

```text
[bluetooth]# [CHG] Device AC:B1:EE:71:A1:51 RSSI: ...
```

Older Blauwerk parsing only accepted clean `[NEW] Device ...` and `[CHG]
Device ...` lines. This made live discovery miss devices even while the initial
dashboard appeared to find them. A second bug made the confusion worse:
completed scans returned the cached `bluetoothctl devices` list, so stale BlueZ
cache entries could be displayed as if they had just been seen over the air.

The fix is deliberately strict:

- ANSI/control sequences and prompt prefixes are stripped before event parsing;
- live scan results contain only devices observed during that scan;
- cached names and aliases may enrich a live hit, but cache entries no longer
  prove that a target is currently advertising;
- related Classic/LE identities are logged as hints, but are not treated as an
  exact target hit.

## Compatibility and support claims

Blauwerk is currently beta software. It can inspect standards-based devices
exposed by BlueZ, but publication does not turn untested hardware into a
guarantee. A reproducible compatibility result depends on the device firmware,
Bluetooth controller, kernel, BlueZ, PipeWire, WirePlumber and session policy.

| Scope | Current state |
| --- | --- |
| Physically verified path | Tribit Home Speaker, Soundcore Boom 2 Pro, and Keychron K1 keyboard on one Linux host/controller |
| Failure modes catalogued | 108 |
| Full observe/guidance/verify playbooks | 108/108 |
| Implemented automatically | 44/108 |
| Partially detected or mitigated | 25/108 |
| Guidance/architecture only | 36 planned, 3 manual/proprietary |
| End-to-end recovery focus | Classic pairing/bonding, adapter power, A2DP output |

`108/108` means every catalogued failure has a stable ID and a safe provisional
playbook: what to observe, what to suggest, and what successful verification
means. It does **not** mean that every failure can already be detected or fixed
automatically. Run `blauwerk coverage` for the live implementation breakdown;
`blauwerk coverage --json` returns the complete machine-readable registry.

The full catalogue and current response for each case lives in
[docs/failure-modes.md](docs/failure-modes.md).

### Linux compatibility envelope

The complete recovery path currently targets a modern desktop Linux system
with Bun, BlueZ/`bluetoothctl`, systemd, udev and sudo. Audio verification and
repair additionally require PipeWire, WirePlumber and `pactl`. This should make
the normal path portable across current systemd-based Arch, Fedora,
Debian/Ubuntu and openSUSE families, but those release lines are not yet a
tested compatibility matrix.

Non-systemd distributions, immutable host configuration, PulseAudio-only
systems, containers, headless sessions, macOS and Windows currently have only
partial or no backend support. Blauwerk must report these boundaries instead of
claiming a successful repair.

## Capability model

Blauwerk derives capabilities from advertised service UUIDs instead of relying
on device names or a model-specific allowlist. The current registry recognizes
36 common Classic and LE profiles/services across nine domains:

- audio and media: A2DP, AVRCP, HSP, HFP and common LE Audio services
- input: Classic HID and HID over GATT
- networking: PANU, NAP, GN and DUN
- data: SPP, OPP, FTP, PBAP and MAP
- sensors and identity: GAP, GATT, Battery Service and PnP Information
- BLE MIDI

Capabilities are also projected into 14 user intents such as music playback,
calls, input, networking, file transfer, sensors, MIDI and battery reporting.
The report retains unknown UUIDs, records a recognition ratio, and marks devices
that combine multiple functional domains. Unknown or proprietary services stay
visible and are never treated as proof that a function works.

## Install

Requirements: Linux, Bun, BlueZ, and `bluetoothctl`. Audio management uses
PipeWire and WirePlumber.

```bash
git clone https://github.com/sayore/blauwerk.git
cd blauwerk
bun install
bun link
```

This installs `blauwerk`; `bt-matrix` remains available as a compatibility
alias.

## Quick start

```bash
blauwerk
blauwerk explore
blauwerk ls --scan
blauwerk inspect AC:B1:EE:71:A1:51
blauwerk connect AC:B1:EE:71:A1:51
blauwerk doctor --hint Tribit
```

Machine-readable output is available with `--json`.

Running `blauwerk` or its compatibility alias `bt-matrix` without a subcommand
opens the device dashboard: known devices are shown immediately, newly
discovered devices appear while scanning, and any visible device can be
selected before discovery finishes. Device-specific checks are shown before an
action.

## Commands

```text
explore                 scan, select, inspect, and manage interactively
ls [--scan]             list normalized device state and capabilities
inspect MAC             show BlueZ capabilities and PipeWire state
status MAC              show Bluetooth and audio state
connect MAC             trust, connect, and ensure an audio node
disconnect MAC          disconnect a device
audio MAC [--fix]       inspect or recover the A2DP transport
doctor                  run the progressive pairing recovery matrix
diagnose                capture controller and audio diagnostics
config [--fix]          audit or safely repair rejected BlueZ settings
power [--fix]           inspect or disable adapter-specific USB autosuspend
coverage [--json]       show the 108-scenario support registry
```

Examples:

```bash
blauwerk config
blauwerk config --fix
blauwerk power
blauwerk power --fix
blauwerk doctor --mac AC:B1:EE:71:A1:51 --scan-seconds 20
blauwerk audio AC:B1:EE:71:A1:51 --fix
```

`config --fix` creates a dated backup before commenting rejected or unsafe
settings. `power --fix` writes a device-specific udev rule; it does not disable
power management for unrelated USB devices. Destructive BlueZ cache cleanup and
controller power cycling require `doctor --aggressive`.

Logs are JSONL files below `~/.cache/blauwerk/`.

## Architecture

- `src/backend.ts` defines the portable Bluetooth backend boundary.
- `src/bluez.ts` implements Linux/BlueZ operations.
- `src/catalog.ts` normalizes device capabilities.
- `src/scenarios.ts` is the machine-readable failure-mode and fallback registry.
- `src/matrix.ts` implements convergent recovery.
- `src/audio.ts` reconciles BlueZ A2DP state with PipeWire/WirePlumber.
- `src/config.ts` and `src/power.ts` provide audited host remediation.

All subprocesses use argument arrays without shell interpolation. Privileged
operations are narrow and explicit; this boundary can later move to a small
polkit-authorized service.

## Development

```bash
bun install
bun test
bun run check
```

## License

MIT. See [LICENSE](LICENSE).
