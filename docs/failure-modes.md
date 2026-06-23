# Blauwerk failure-mode catalog

This document defines the Bluetooth problems Blauwerk should recognize and how
far the current implementation can handle them. It is intentionally broader
than one Linux installation or one device.

Status:

- **handled** — detected and remediated by the current CLI
- **partial** — detected or mitigated, but not fully verified
- **planned** — the architecture has a place for it, implementation is missing
- **manual** — safe automation is impossible; Blauwerk should explain the step

The product rule is: `Connected: yes` is not success. Success means that the
user's intended function works — audio sink, microphone, input events, force
feedback, MIDI node, readable GATT characteristic, network service, and so on.

## Coverage semantics

All 108 entries below are mirrored by `src/scenarios.ts`. Every registry entry
has a stable ID plus three generic fallback stages:

1. **observe** — the evidence a backend or diagnostic bundle must collect;
2. **guidance** — a safe next action or an explicit platform/device boundary;
3. **verify** — the intent-specific condition that constitutes success.

This gives Blauwerk **108/108 catalogue and guidance coverage** even when the
hardware required to implement and validate a specialized probe is unavailable.
It does not change the implementation status below: currently 34 are handled,
25 are partial, 46 are planned, and 3 require a manual or proprietary path.
`blauwerk coverage --json` exposes both layers for tooling and future telemetry.

The capability abstraction follows the same rule. Known UUIDs are mapped to
profiles, domains and user intents; unknown UUIDs are retained as evidence.
Advertising a capability is not considered proof that its intended function is
working.

## Discovery and identity

| Failure mode | Detection | Current response | Status / target |
| --- | --- | --- | --- |
| Controller is powered off | Controller state | `prepare()` powers it on | handled |
| rfkill / airplane mode | `rfkill`, controller errors | automatic unblock via rfkill | handled |
| Wrong default adapter | multiple `hci*` controllers | first controller is used | planned: score and select adapters |
| Adapter lacks BR/EDR or LE | controller capabilities | scan failure | planned: skip impossible strategies |
| Device is not advertising | full BR/EDR + general scan | stop instead of destructive escalation | handled |
| Device is connectable but not discoverable | existing bond plus failed discovery | generic connect attempted | partial: distinguish connectable from absent |
| Duplicate Classic and LE identities | address and name only | automatic identity merge | handled |
| Rotating BLE private address | random MAC changes | treated as new device | planned: fingerprint identity data |
| Multiple devices share a name | list selection | user selects by index/MAC | partial: add RSSI and manufacturer fingerprint |
| Unknown device name | MAC shown | selectable | handled |
| Scan filter misses passive advertisements | no result | general scan fallback | partial: passive/active scan policies |
| Weak or unstable signal | RSSI snapshot | displayed when available | partial: trend and proximity warning |
| 2.4 GHz / USB 3 interference | poor RSSI and retries | RSSI warning in advisor | handled |
| Device changes identity after factory reset | old MAC no longer appears | hint-based scan can find name | partial: suggest identity replacement |
| Device already connected to another host | remote page/auth failures | multipoint signature check | handled |
| Multipoint slots are full | repeated remote rejection | generic error | planned: explain device-side slot cleanup |

## Pairing, bonding, and security

| Failure mode | Detection | Current response | Status / target |
| --- | --- | --- | --- |
| No pairing agent | Pair returns agent error | temporary bluetoothctl agent | partial: persistent D-Bus agent |
| Wrong I/O capability | auth failure per agent | recovery matrix varies agents | partial: infer from Class/Appearance |
| Numeric confirmation required | agent callback | interactive agent prompts | handled |
| Passkey must be entered on host | agent callback | interactive agent prompts | handled |
| Passkey must be typed on device | agent callback | interactive agent prompts | handled |
| Legacy PIN (`0000`, `1234`) | `LegacyPairing` | not parsed/classified | planned: safe PIN workflow |
| Pairing already in progress | `InProgress` | cancel before retry | handled |
| CLI timeout but BlueZ succeeded | post-command state | reconcile `Paired=yes` | handled |
| Authentication rejected | BlueZ error | stop host escalation | handled |
| Authentication timeout | BlueZ error | cancel and retry | partial: classify device/UI cause |
| Stale host-side link key | inconsistent pair/bond state | remove selected device | handled in recovery |
| Stale device-side link key | pairing repeatedly disappears | reported as pair lost | manual: explain device reset |
| Device bond table is full | transient pair then loss | pair-lost signature analysis | handled |
| Paired but not bonded | state polling | preserve usable session by default | handled |
| Bond exists but device is untrusted | state | trust before connect | handled |
| Blocked device | `Blocked=yes` | automatic unblock on connect | handled |
| Secure Connections incompatibility | auth/link-key failures | generic stop | planned: capability diagnosis; no silent downgrade |
| CTKD / dual-bearer key mismatch | Classic/LE bond disagreement | not modeled | planned: bearer-aware bond state |
| OOB/NFC pairing required | device behavior | unsupported | manual: explain unsupported requirement |
| Profile authorization required | agent callback | trust may bypass later prompts | partial: persistent authorization agent |

## Connection and profile negotiation

| Failure mode | Detection | Current response | Status / target |
| --- | --- | --- | --- |
| ACL connected but no usable profile | Connected with missing app capability | audio layer checked separately | handled for A2DP only |
| Connect operation still pending | `InProgress` / busy | serialized attempts and polling | partial: direct D-Bus operation tracking |
| Command times out after success | post-command state | reconcile pairing/connect state | partial |
| Wrong bearer selected on dual-mode device | bearer-specific failure | BR/EDR and general scan matrix | partial: parse AddressType/Bearer |
| Profile direction confusion | remote UUID versus local role | A2DP remote Sink UUID used | handled for speaker playback |
| Device exposes only a subset of profiles | UUID inventory | capability labels | handled for common profiles |
| Service discovery is slow | UUIDs/ServicesResolved | bounded settling wait | handled |
| Service discovery never completes | no UUIDs | reported indirectly | partial: explicit service-resolution failure |
| Remote terminates link | disconnect after pair/connect | pair-lost stop | partial: decode HCI reason |
| Kernel/controller page timeout | BlueZ error | shown in log | partial: power/signal/hardware diagnosis |
| Connection retries make state worse | repeated matrix attempts | stops on absence/auth rejection | partial: global retry budget/backoff |
| Another Bluetooth manager competes | busy/in-progress patterns | competing app checks via pgrep | handled |
| Device firmware crashes under parallel profiles | busy/remote drop | serialized audio recovery | partial |

## Audio devices

| Failure mode | Detection | Current response | Status / target |
| --- | --- | --- | --- |
| PipeWire server unavailable | pactl failure | restart user audio stack | handled |
| WirePlumber BlueZ monitor missing | no card despite connected audio UUID | restart WirePlumber once | partial: verify plugin/package |
| `bluez_card` missing | pactl inventory | A2DP recovery | handled |
| Card exists but output sink is missing | card/sink inventory | activate A2DP profile | handled |
| A2DP transport Acquire fails | currently only journal evidence | WirePlumber & profile resets | handled |
| Transport is busy | connect error | serialized retry | partial |
| No common codec | endpoint negotiation failure | no codec diagnosis | planned: codec intersection and SBC fallback |
| High-quality codec is unstable | repeated transport loss | fallback SBC profile cycling | handled |
| LE Audio device lacks BAP support | BAP UUID/role | not classified | planned |
| Headset supports music but no microphone | UUID/profile inventory | capability label is incomplete | planned: input/output intent verification |
| HFP/HSP backend missing | no headset profile | not diagnosed | planned: WirePlumber backend check |
| Microphone use downgrades music quality | profile change | not explained | planned: `music` versus `call` intent |
| Absolute volume is broken | mute/jump behavior | not detected | planned: per-device volume quirk |
| Sink exists but desktop UI omits it | PipeWire okay, UI missing | state reveals boundary | partial: set default/reload UI hint |
| Application stays on old sink | stream routing inventory | automatic pactl stream migration | handled |
| Wrong default output | metadata/default node | automatic default sink routing | handled |
| Codec latency is poor for gaming | selected codec/profile | not measured | planned: `gaming-audio` policy |
| Audio device is both Sink and Source | UUIDs | both labels shown | partial: select role by intent |

## Controllers, keyboards, mice, and HID

| Failure mode | Detection | Current response | Status / target |
| --- | --- | --- | --- |
| USB Bluetooth adapter autosuspends | sysfs runtime PM | device-specific udev fix | handled |
| Gamepad sleeps from its own firmware | repeated clean remote disconnect | not distinguished | planned: warn that host may not control it |
| Host idle policy disconnects HID | policy/config inspection | not audited | planned: gaming power policy |
| HID connects but creates no input node | `/dev/input`, udev, HID state | not verified | planned: evdev probe |
| hidraw permission denied | device permissions | not checked | planned: concrete udev/group advice |
| Wrong kernel HID driver | Modalias/driver binding | not checked | planned: driver recommendation |
| Rumble/force feedback unavailable | evdev FF bits | not checked | planned: feature verification |
| Gyro/touchpad unavailable | input capability bits | not checked | planned |
| SDL/Steam mapping missing | SDL GUID and input layout | not checked | planned: mapping advice |
| Nintendo/PlayStation/Xbox quirks | VID/PID/Modalias | generic HID classification | planned: quirk database |
| Keyboard needs secure passkey entry | agent interaction | not supported robustly | planned: persistent agent UX |
| Input device should wake system | sysfs wakeup policy | only adapter power inspected | planned: per-device wake policy |
| Battery level unavailable | Battery1/provider state | not parsed | planned |
| Controller has audio endpoints | HID plus A2DP/HFP | profiles treated independently | planned: composite-device intent |

## BLE, sensors, MIDI, and specialized devices

| Failure mode | Detection | Current response | Status / target |
| --- | --- | --- | --- |
| GATT services resolve slowly | ServicesResolved/GattServices | bounded generic wait | partial |
| Required GATT service is absent | service UUID inventory | labels only common profiles | planned: intent-specific required UUID |
| Characteristic requires encryption | GATT error | not supported | planned: security-level diagnosis |
| Characteristic requires authorization | agent/GATT error | not supported | planned |
| MTU is too small for operation | GATT I/O error | not modeled | planned |
| BLE connection interval favors battery over latency | connection parameters | not modeled | planned: latency/battery policy |
| Notification subscription fails | GATT flags/errors | not modeled | planned |
| BLE MIDI node missing | MIDI service plus PipeWire graph | not verified | planned |
| PAN/network profile missing | NAP/PAN UUID | capability label only | planned: network interface probe |
| OBEX/file transfer unavailable | OBEX service/package | not detected | planned |
| Proprietary vendor protocol | manufacturer/service data | shown only as raw data | manual/plugin extension point |

## Controller, kernel, and host environment

| Failure mode | Detection | Current response | Status / target |
| --- | --- | --- | --- |
| Broken/fake USB controller | VID:PID and kernel warnings | diagnostics plus power mitigation | partial: quirk knowledge base |
| Missing controller firmware | kernel journal | not parsed | planned: package-level advice |
| USB hub power instability | reset/disconnect kernel events | not parsed | planned: port/hub recommendation |
| Resume leaves HCI stuck | boot/resume timeline | service restart/powercycle available | partial |
| Invalid BlueZ config | config audit | backed-up targeted fix | handled for known settings |
| Kernel regression | compare kernel/boot metadata | manual comparison | planned: diagnostic bundle comparison |
| PulseAudio and PipeWire conflict | process/service inventory | process collision diagnostics | handled |
| No user D-Bus/session | command failures | automatic DBUS address detection | handled |
| Flatpak/container blocks Bluetooth or audio | bus/portal errors | generic failure | planned: sandbox-aware hint |
| Polkit/sudo unavailable | privileged action failure | `--no-sudo` and error | partial: polkit helper |
| Multiple users/seats compete for Bluetooth audio | logind/seat and monitor state | not modeled | planned |

## Cross-platform boundary

| Failure mode | Detection | Current response | Status / target |
| --- | --- | --- | --- |
| Platform has no BlueZ | backend selection | startup failure | planned: backend registry |
| macOS exposes BLE but restricts generic Classic management | backend capabilities | not implemented | planned: declare unsupported operations |
| Windows pairing requires OS consent UI | backend capabilities | not implemented | planned: handoff to native consent flow |
| Different platforms expose different profile state | backend contract | only common device fields | planned: feature/capability negotiation |
| A platform cannot apply a requested optimization | backend capability | not represented | planned: explain rather than emulate success |

## Intended one-command flow

The default `blauwerk` command should:

1. Inventory adapters and host-level warnings.
2. Show known devices immediately.
3. Scan BR/EDR and LE while displaying progress.
4. Show newly discovered devices separately.
5. Let the user select a device by number.
6. Infer an intent (`music`, `call`, `gaming`, `input`, `sensor`, `midi`).
7. Show selectable checks before mutating anything.
8. Apply only safe, reversible remediation by default.
9. Verify the intended function, not merely the Bluetooth link.
10. Return one of: working, working with limitations, user action required,
    unsupported capability, or host defect.

## Architecture required to close the planned gaps

1. Replace `bluetoothctl` output parsing with the BlueZ D-Bus API.
2. Add a persistent `blauwerkd` agent for pairing and authorization callbacks.
3. Track operations from D-Bus events instead of fixed sleeps.
4. Add typed device identities across Classic and LE bearers.
5. Add intent-specific probes for PipeWire, evdev/hidraw, GATT, MIDI, and PAN.
6. Maintain a versioned, inspectable controller/device quirk database.
7. Make every remediation a journaled transaction with rollback.
8. Add backend capability negotiation before macOS/Windows implementations.

The generic fallback registry and capability data model may exist before their
hardware probes. A scenario moves from `planned` only when detection or
remediation exists in code, and it moves to `handled` only when Blauwerk
verifies the intended result.

## Generic solution matrix versus known-device quirks

Blauwerk's primary decision system must stay generic:

1. Observe state and capabilities.
2. Match a generic failure predicate.
3. Offer a generic, reversible solution.
4. Verify the intended function.

A known-device matrix is a secondary evidence layer only. Entries may identify
proven firmware/controller quirks by VID/PID, Modalias, manufacturer data, or a
stable fingerprint. They may adjust timeouts, disable a demonstrably broken
feature, or improve instructions. They must not replace generic state checks,
silently reduce security, or claim success without verification.

## Primary references

- [BlueZ Device API](https://bluez.readthedocs.io/en/latest/device-api/)
- [WirePlumber Bluetooth configuration](https://github.com/PipeWire/wireplumber/blob/master/src/config/wireplumber.conf.d.examples/bluetooth.conf)
- [Linux USB power management](https://docs.kernel.org/driver-api/usb/power-management.html)
