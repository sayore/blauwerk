# Blauwerk

Blauwerk is a Bun/TypeScript CLI for inspecting, connecting, and recovering
Bluetooth devices. The current Linux backend integrates BlueZ with
WirePlumber/PipeWire while keeping platform-specific operations behind a small
backend interface.

It treats recovery as a convergent state machine: every step re-reads device
state, preserves completed work, and escalates only as far as necessary.

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
blauwerk explore
blauwerk ls --scan
blauwerk inspect AC:B1:EE:71:A1:51
blauwerk connect AC:B1:EE:71:A1:51
blauwerk doctor --hint Tribit
```

Machine-readable output is available with `--json`.

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
