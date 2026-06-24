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


It treats recovery as a convergent state machine: every step re-reads device
state, preserves completed work, and escalates only as far as necessary.

Safety invariants:

- a cached BlueZ device is never treated as proof of a live advertisement;
- a working unbonded session is preserved unless rebonding was explicitly chosen;
- rebonding verifies that the target is pairing-ready before removing ephemeral state;
- discovery stops as soon as the selected target is seen;
- cache purge and controller power cycling remain explicit `--aggressive` actions;
- success is re-read from BlueZ and the intent-specific subsystem after every mutation.

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
