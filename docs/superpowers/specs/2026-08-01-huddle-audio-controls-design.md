# Huddle Audio Controls — Push-to-Talk, Per-Peer Volume, Device Selection

**Date:** 2026-08-01
**Status:** Approved (design) — pending implementation plan
**Owner:** James McDaniel
**Predecessors:** `2026-07-31-flow-huddle-turn-and-recovery-design.md`,
`2026-08-01-huddle-awareness-design.md`

## Problem

The huddle offers one audio control: a single mute toggle. Missing are the
things people expect from any voice tool — a way to talk without leaving your
mic open, a way to turn down whoever is in a noisy room, and a way to pick which
microphone and speakers to use. All of it is client-side; none of it needs a
schema, an endpoint, or a new dependency.

While rewriting the `ontrack` handler for per-peer volume, one latent bug in it
gets fixed (below).

## Decisions

| Area | Decision | Why |
|---|---|---|
| Push-to-talk | **An explicit mode you toggle on** | A hold-to-override-mute design means a deliberate mute is never quite a mute — resting a hand on the keyboard transmits. That is the audio failure people actually resent. |
| PTT key | **Space** | Verified unbound: neither the page handler (`page.tsx:1078`) nor the canvas handler (`graph-canvas.tsx:466`) uses it, and there is no space-to-pan. |
| Volume slider | **Native `<input type="range">`** | No slider package is installed; this needs no new dependency. |
| Output selection | **Feature-detected, absent where unsupported** | `setSinkId` is Chrome/Edge. A visible-but-inert control is worse than none. |
| Volume persistence | **Keyed by clientId in a ref, outliving the peer** | A reconnect builds a fresh connection and audio element; without this, turning someone down silently undoes itself on their next wifi blip. |
| Bar structure | **Split into three files** | The pill would otherwise grow past ~250 lines carrying two popovers. |

## Section 1 — Push-to-talk

New pure module `src/lib/flows/push-to-talk.ts`:

```
PTT_KEY = ' '
isPttTrigger(key: string, target: EditableTarget | null, repeat: boolean): boolean
micEnabled(muted: boolean, pttEnabled: boolean, pttHeld: boolean): boolean
```

`EditableTarget = { tagName?: string; isContentEditable?: boolean }`.

`isPttTrigger` returns true only for Space, non-repeat, on a target that is not
`INPUT` / `TEXTAREA` / `SELECT` / `isContentEditable` — the same guard both
existing global key handlers use, which also covers the CodeMirror editors since
they render contentEditable.

`micEnabled` is the single source of truth for whether the local track is live:

- PTT off → `!muted` (today's behaviour, unchanged)
- PTT on → `pttHeld`, and the mute flag is ignored

Putting it in one tested function is the point of the section. Without it, "am I
transmitting?" is a condition spread across a keydown handler, a keyup handler, a
blur handler, and a mute button, which is how people end up live when they think
they are not.

The hook adds `pttEnabled`, `setPttEnabled`, and `transmitting`, and applies
`track.enabled = micEnabled(...)` from a single effect keyed on
`[muted, pttEnabled, pttHeld]`.

Release paths, all of which must silence the mic: keyup, turning the mode off,
window `blur`, and leaving the huddle. Blur matters because tabbing away
mid-hold would otherwise leave you transmitting into a conversation you have
walked away from.

While PTT is on the bar shows a PTT indicator **in place of** the mute button —
two competing mute concepts side by side is how people lose track of their own
state.

## Section 2 — Per-peer volume and local mute

Clicking a member avatar opens a popover (Radix dropdown-menu, already a
dependency) with a volume slider and a local mute toggle. Local mute is distinct
from muting yourself: it silences that person for you only, and is not
broadcast.

State lives in a `Map<clientId, { volume: number; muted: boolean }>` held in a
ref, mirrored into React state for rendering. It is **not** cleared by
`closePeer`, only by `leave()`. New audio elements read from it on creation, so
a peer who reconnects comes back at the volume you set.

### The `ontrack` leak

Today the handler creates an audio element and assigns `entry.audio` without
removing what was there. If `ontrack` fires twice for a peer — renegotiation, or
a second track — the first element is orphaned in `document.body`, still
attached and still playing, unreferenced and therefore uncleanable. It is not
reachable through the current ICE-restart path, which is why it has not bitten.
The rewritten handler removes any existing element before assigning, closing the
trap before video or screenshare ever opens it.

## Section 3 — Device selection

New pure module `src/lib/flows/audio-devices.ts`:

```
partitionDevices(devices: MediaDeviceInfo[]): { inputs: DeviceOption[]; outputs: DeviceOption[] }
DeviceOption = { deviceId: string; label: string }
```

Drops entries with an empty `deviceId` (what `enumerateDevices()` returns before
permission is granted) and supplies fallback labels — "Microphone 1",
"Speaker 2" — because labels are empty until permission is granted.

A gear in the bar opens a popover with the two selects.

**Input switching mid-huddle** calls `getUserMedia` with the chosen
`deviceId`, then `sender.replaceTrack(newTrack)` on every peer connection.
`replaceTrack` needs no renegotiation, so nobody drops. The old tracks are
stopped, the analyser is re-attached to the new stream, and the current
`micEnabled(...)` state is re-applied — otherwise switching mics while muted
would quietly unmute you.

**Output switching** calls `setSinkId(deviceId)` on every peer audio element and
stores the choice so elements created later adopt it. Feature-detected via
`'setSinkId' in HTMLMediaElement.prototype`; when absent the control is not
rendered. Safari and Firefox users therefore get input selection only — a real
limitation, not a bug to chase.

Device changes are picked up by listening to `navigator.mediaDevices`
`devicechange`, so plugging in a headset mid-call repopulates the lists.

## Files

| File | Change |
|---|---|
| `src/lib/flows/push-to-talk.ts` | **New** — `isPttTrigger`, `micEnabled` |
| `src/lib/flows/audio-devices.ts` | **New** — `partitionDevices` |
| `src/lib/flows/use-flow-huddle.ts` | PTT state and listeners, per-peer volume map, device switching, `ontrack` leak fix |
| `src/components/flows/huddle-bar.tsx` | PTT toggle, gear, clickable avatars |
| `src/components/flows/huddle-settings-menu.tsx` | **New** — device popover |
| `src/components/flows/huddle-member-controls.tsx` | **New** — per-member popover |
| `src/app/flows/[id]/page.tsx` | Pass the new props through |
| Tests | New unit tests per pure module; component tests for the PTT toggle and member popover |

## Build order

Three independently shippable pieces:

1. **Push-to-talk** — self-contained, no `ontrack` changes.
2. **Per-peer volume and local mute**, including the leak fix.
3. **Device selection** — largest, and the most browser-variable.

Each is useful alone; stopping after any of them leaves a coherent product.

## Testing

- **Unit:** every `micEnabled` combination (six: PTT on/off × muted/held);
  `isPttTrigger` across Space, non-Space, repeats, and each editable target
  type; `partitionDevices` with empty ids, missing labels, and mixed kinds.
- **Component:** the PTT toggle replaces the mute button when enabled; the
  member popover renders a slider reflecting current volume.
- **Manual, and not substitutable by the suite:** holding Space transmits and
  releasing stops; typing a space in a step editor or the copilot does not
  transmit; switching input mid-call keeps everyone connected; `setSinkId`
  actually moves audio on Chrome; the output picker is absent on Safari.

Real audio hardware and cross-browser behaviour cannot be exercised from the
test environment. The suite covers the decision logic, not whether sound moves.

## Out of scope

SFU migration for rooms beyond ~6 participants; huddle transcript feeding the
copilot; noise suppression and echo-cancellation tuning; per-peer volume
persisted across sessions (it resets when you leave, deliberately — a stale
volume from last week is a confusing default).
