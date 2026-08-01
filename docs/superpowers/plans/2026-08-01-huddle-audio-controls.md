# Huddle Audio Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the huddle the audio controls people expect — push-to-talk, per-peer volume and local mute, and microphone/speaker selection.

**Architecture:** All client-side. Three pure modules hold the decision logic (`push-to-talk.ts`, `audio-devices.ts`), following the established `huddle-signals.ts` / `peer-recovery.ts` pattern; `useFlowHuddle` performs the WebRTC and DOM effects; the huddle bar splits into three components rather than growing past 250 lines.

**Tech Stack:** React 18, WebRTC, Web Audio, Radix dropdown-menu (already a dependency), `node:test` + `tsx`, Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-01-huddle-audio-controls-design.md`

## Global Constraints

- **Tests** use `node:test` + `node:assert/strict`, live under `__tests__`, React tests are `.test.tsx` with `import '@/test-support/jsdom-env'` FIRST.
- **Run one test file:** `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <path>`
- **Full gate:** `npm run typecheck && npm run lint && npm test`. Never `npm run build` — it fails locally without Supabase env vars, by design.
- **No new dependencies.** Volume uses a native `<input type="range">`.
- **No raw token syntax** (`{{...}}`) in user-facing copy.
- **Lint is zero-error with 8 pre-existing warnings.** Any new warning is yours — fix it properly, do not suppress. In particular, reading `huddle.x` inside a `useEffect` trips `react-hooks/exhaustive-deps`; destructure before the effect.
- **Commit after each task.** Direct to `main`.

---

### Task 1: Push-to-talk policy

**Files:**
- Create: `src/lib/flows/push-to-talk.ts`
- Test: `src/lib/flows/__tests__/push-to-talk.test.ts`

**Interfaces:**
- Produces: `PTT_KEY`, `type EditableTarget = { tagName?: string; isContentEditable?: boolean }`, `isPttTrigger(key, target, repeat): boolean`, `micEnabled(muted, pttEnabled, pttHeld): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/lib/flows/__tests__/push-to-talk.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPttTrigger, micEnabled, PTT_KEY } from '../push-to-talk'

test('space on the page triggers; other keys do not', () => {
  assert.equal(isPttTrigger(PTT_KEY, { tagName: 'DIV' }, false), true)
  assert.equal(isPttTrigger('a', { tagName: 'DIV' }, false), false)
  assert.equal(isPttTrigger('Enter', { tagName: 'DIV' }, false), false)
})

test('auto-repeat never re-triggers', () => {
  assert.equal(isPttTrigger(PTT_KEY, { tagName: 'DIV' }, true), false)
})

test('typing a space in an editor never opens the mic', () => {
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    assert.equal(isPttTrigger(PTT_KEY, { tagName }, false), false, tagName)
  }
  // CodeMirror renders contentEditable, not a textarea.
  assert.equal(isPttTrigger(PTT_KEY, { tagName: 'DIV', isContentEditable: true }, false), false)
})

test('a null target is treated as the page', () => {
  assert.equal(isPttTrigger(PTT_KEY, null, false), true)
})

test('with PTT off, the mute button decides', () => {
  assert.equal(micEnabled(false, false, false), true)
  assert.equal(micEnabled(true, false, false), false)
  // Holding space with the mode off changes nothing.
  assert.equal(micEnabled(true, false, true), false)
})

test('with PTT on, only holding the key transmits — mute is ignored', () => {
  assert.equal(micEnabled(false, true, false), false)
  assert.equal(micEnabled(false, true, true), true)
  assert.equal(micEnabled(true, true, true), true)
  assert.equal(micEnabled(true, true, false), false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/push-to-talk.test.ts`
Expected: FAIL — cannot find module `../push-to-talk`.

- [ ] **Step 3: Implement**

Create `src/lib/flows/push-to-talk.ts`:

```ts
/** Hold-to-talk key. Verified unbound elsewhere in the flow builder: neither
 *  the page's global handler nor the canvas's uses Space, and there is no
 *  space-to-pan. */
export const PTT_KEY = ' '

/** The slice of an event target this guard needs. */
export type EditableTarget = { tagName?: string; isContentEditable?: boolean }

const EDITABLE_TAGS = ['INPUT', 'TEXTAREA', 'SELECT']

/**
 * Whether a keyboard event should drive push-to-talk. Mirrors the
 * editable-target guard both existing global key handlers use, so typing a
 * space in a step editor, the copilot, or a CodeMirror block (contentEditable)
 * never opens the microphone.
 */
export function isPttTrigger(key: string, target: EditableTarget | null, repeat: boolean): boolean {
  if (key !== PTT_KEY || repeat) return false
  if (!target) return true
  if (target.isContentEditable) return false
  return !EDITABLE_TAGS.includes(target.tagName ?? '')
}

/**
 * The single source of truth for whether the local microphone track is live.
 *
 * Spreading this across the keydown, keyup, blur and mute handlers is how
 * people end up transmitting while believing they are muted — so every one of
 * those paths funnels through here instead.
 */
export function micEnabled(muted: boolean, pttEnabled: boolean, pttHeld: boolean): boolean {
  return pttEnabled ? pttHeld : !muted
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/push-to-talk.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/push-to-talk.ts src/lib/flows/__tests__/push-to-talk.test.ts
git commit -m "feat(flows): push-to-talk policy — trigger guard and mic-enabled rule"
```

---

### Task 2: Wire push-to-talk

**Files:**
- Modify: `src/lib/flows/use-flow-huddle.ts`
- Modify: `src/components/flows/huddle-bar.tsx`
- Modify: `src/app/flows/[id]/page.tsx`
- Test: extend `src/components/flows/__tests__/huddle-bar.test.tsx`

**Interfaces:**
- Consumes: `isPttTrigger`, `micEnabled`, `PTT_KEY` from Task 1.
- Produces: `useFlowHuddle` additionally returns `pttEnabled: boolean`, `setPttEnabled: (on: boolean) => void`, `transmitting: boolean`. `HuddleBar` gains `pttEnabled?: boolean`, `transmitting?: boolean`, `onTogglePtt?: () => void`.

- [ ] **Step 1: Add PTT state and the single mic-enable effect**

In `src/lib/flows/use-flow-huddle.ts`, add the import:

```ts
import { isPttTrigger, micEnabled } from '@/lib/flows/push-to-talk'
```

Add state beside `muted`:

```ts
  const [pttEnabled, setPttEnabledState] = useState(false)
  const [pttHeld, setPttHeld] = useState(false)
```

Replace the body of `toggleMute` so it no longer touches tracks directly — a
single effect owns track state now:

```ts
  const toggleMute = useCallback(() => {
    setMuted((current) => !current)
  }, [])
```

Add the effect that owns the local track, after the speaking-pulse effect:

```ts
  // The ONLY place the local track's enabled flag is set. Every path that can
  // change it — mute, PTT mode, key hold, blur — flows through micEnabled.
  useEffect(() => {
    const live = micEnabled(muted, pttEnabled, pttHeld)
    localStream.current?.getAudioTracks().forEach((track) => { track.enabled = live })
  }, [muted, pttEnabled, pttHeld, joined])
```

- [ ] **Step 2: Add the key and blur listeners**

Still in the hook, after that effect:

```ts
  // Push-to-talk. Bound only while the mode is on and we're in the huddle, so
  // Space behaves normally everywhere else in the builder.
  useEffect(() => {
    if (!joined || !pttEnabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPttTrigger(event.key, event.target as HTMLElement | null, event.repeat)) return
      event.preventDefault() // Space would otherwise scroll the page
      setPttHeld(true)
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== ' ') return
      setPttHeld(false)
    }
    // Tabbing away mid-hold must not leave us transmitting into a conversation
    // we've walked away from — keyup never arrives if the window loses focus.
    const onBlur = () => setPttHeld(false)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      setPttHeld(false)
    }
  }, [joined, pttEnabled])
```

Add the setter that always drops the hold when the mode changes, and expose the
derived transmitting flag:

```ts
  const setPttEnabled = useCallback((on: boolean) => {
    setPttEnabledState(on)
    setPttHeld(false)
  }, [])

  const transmitting = joined && micEnabled(muted, pttEnabled, pttHeld)
```

In `leave`, reset both:

```ts
    setPttHeld(false)
```

Widen the return:

```ts
  return { joined, connecting, muted, speakingIds, error, peerStates, pttEnabled, transmitting, join, leave, toggleMute, setPttEnabled, clearError }
```

- [ ] **Step 2b: Verify the analyser still reflects PTT**

The speaking pulse reads the analyser, which is fed by the stream regardless of
`track.enabled`. Confirm by reading the effect: if `speakingIds` would include
self while not transmitting, gate the self branch on `transmitting`:

```ts
      if (localAnalyser.current && transmitting) {
```

Add `transmitting` to that effect's dependency array. Without this the bar
would show you pulsing as if talking while your track is disabled — the most
misleading possible state.

- [ ] **Step 3: Add the bar control**

In `src/components/flows/huddle-bar.tsx`, add props `pttEnabled?: boolean`,
`transmitting?: boolean`, `onTogglePtt?: () => void`, and `Radio` to the
`lucide-react` import.

Replace the mute button with a conditional. When `pttEnabled`, the PTT
indicator stands **in place of** the mute button, not beside it:

```tsx
              {pttEnabled ? (
                <Button
                  variant={transmitting ? 'default' : 'outline'}
                  size="sm"
                  className="rounded-full"
                  onClick={onTogglePtt}
                  aria-label="Turn off push to talk"
                  title="Push to talk is on — hold Space to speak"
                >
                  <Radio className={cn('mr-1.5 h-4 w-4', transmitting && 'animate-pulse')} />
                  {transmitting ? 'Live' : 'Hold Space'}
                </Button>
              ) : (
                <>
                  <Button variant={muted ? 'default' : 'outline'} size="sm" className="rounded-full" onClick={onToggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
                    {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                  </Button>
                  <Button variant="outline" size="sm" className="rounded-full" onClick={onTogglePtt} aria-label="Turn on push to talk" title="Push to talk">
                    <Radio className="h-4 w-4" />
                  </Button>
                </>
              )}
```

Keep the existing Leave button after this block, unchanged.

- [ ] **Step 4: Pass the props through the page**

In `src/app/flows/[id]/page.tsx` at the `<HuddleBar ... />` usage:

```tsx
          pttEnabled={huddle.pttEnabled}
          transmitting={huddle.transmitting}
          onTogglePtt={() => huddle.setPttEnabled(!huddle.pttEnabled)}
```

- [ ] **Step 5: Extend the bar test**

Append to `src/components/flows/__tests__/huddle-bar.test.tsx`:

```tsx
test('push-to-talk replaces the mute button rather than sitting beside it', () => {
  render(<HuddleBar {...base} joined pttEnabled members={[{ clientId: 'a', name: 'Ada', color: '#f00' }]} />)
  assert.equal(screen.queryByLabelText('Mute'), null, 'no competing mute control')
  assert.ok(screen.getByLabelText('Turn off push to talk'))
  cleanup()
})

test('with push-to-talk off both mute and the PTT toggle are offered', () => {
  render(<HuddleBar {...base} joined members={[{ clientId: 'a', name: 'Ada', color: '#f00' }]} />)
  assert.ok(screen.getByLabelText('Mute'))
  assert.ok(screen.getByLabelText('Turn on push to talk'))
  cleanup()
})
```

- [ ] **Step 6: Run tests, typecheck, lint**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/__tests__/huddle-bar.test.tsx`
Expected: PASS — 5 tests.

Run: `npm run typecheck && npx eslint src/lib/flows/use-flow-huddle.ts src/components/flows/huddle-bar.tsx "src/app/flows/[id]/page.tsx"`
Expected: no errors, no new warnings.

- [ ] **Step 7: Commit**

```bash
git add src/lib/flows/use-flow-huddle.ts src/components/flows/huddle-bar.tsx src/components/flows/__tests__/huddle-bar.test.tsx "src/app/flows/[id]/page.tsx"
git commit -m "feat(flows): push-to-talk mode for the voice huddle"
```

---

### Task 3: Per-peer volume, local mute, and the ontrack leak

**Files:**
- Modify: `src/lib/flows/use-flow-huddle.ts`
- Create: `src/components/flows/huddle-member-controls.tsx`
- Modify: `src/components/flows/huddle-bar.tsx`
- Modify: `src/app/flows/[id]/page.tsx`
- Test: `src/components/flows/__tests__/huddle-member-controls.test.tsx`

**Interfaces:**
- Produces: `useFlowHuddle` additionally returns `peerAudio: Map<string, PeerAudioSettings>` and `setPeerAudio(clientId, patch)`, where `export type PeerAudioSettings = { volume: number; muted: boolean }`. `HuddleBar` gains `peerAudio?: Map<string, PeerAudioSettings>` and `onPeerAudioChange?: (clientId, patch) => void`.

- [ ] **Step 1: Add the settings map**

In `src/lib/flows/use-flow-huddle.ts`, add above the hook:

```ts
/** Per-peer playback, local to this listener. Not broadcast. */
export type PeerAudioSettings = { volume: number; muted: boolean }

const DEFAULT_PEER_AUDIO: PeerAudioSettings = { volume: 1, muted: false }
```

Add state and ref inside the hook:

```ts
  const [peerAudio, setPeerAudioState] = useState<Map<string, PeerAudioSettings>>(new Map())
  // Deliberately NOT cleared by closePeer: a reconnect builds a fresh audio
  // element, and without this your volume choice would silently reset every
  // time that peer's wifi hiccupped.
  const peerAudioRef = useRef<Map<string, PeerAudioSettings>>(new Map())
```

Add the applier and setter, after `closePeer`:

```ts
  const applyPeerAudio = useCallback((peerId: string) => {
    const entry = peers.current.get(peerId)
    const settings = peerAudioRef.current.get(peerId) ?? DEFAULT_PEER_AUDIO
    if (!entry?.audio) return
    entry.audio.volume = settings.volume
    entry.audio.muted = settings.muted
  }, [])

  const setPeerAudio = useCallback((peerId: string, patch: Partial<PeerAudioSettings>) => {
    const next = { ...(peerAudioRef.current.get(peerId) ?? DEFAULT_PEER_AUDIO), ...patch }
    peerAudioRef.current.set(peerId, next)
    setPeerAudioState(new Map(peerAudioRef.current))
    applyPeerAudio(peerId)
  }, [applyPeerAudio])
```

- [ ] **Step 2: Fix the leak and apply settings on track arrival**

In `createPeer`'s `ontrack`, replace the element-assignment block:

```ts
      const entry = peers.current.get(peerId)
      if (entry) {
        // Remove any previous element first. Without this a second ontrack —
        // renegotiation, or a second track — orphans the first element in the
        // body, still attached and still playing, with nothing referencing it.
        entry.audio?.remove()
        entry.audio = audio
        entry.analyser = attachAnalyser(stream)
        applyPeerAudio(peerId)
      }
```

Add `applyPeerAudio` to `createPeer`'s dependency array.

In `leave`, clear both:

```ts
    peerAudioRef.current.clear()
    setPeerAudioState(new Map())
```

Return `peerAudio` and `setPeerAudio` from the hook.

- [ ] **Step 3: Build the member popover**

Create `src/components/flows/huddle-member-controls.tsx`:

```tsx
'use client'

import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Volume2, VolumeX } from 'lucide-react'
import type { PeerAudioSettings } from '@/lib/flows/use-flow-huddle'
import { cn } from '@/lib/utils'

/**
 * Per-member playback controls, local to this listener — muting someone here
 * silences them for you only and is never broadcast.
 */
export function HuddleMemberControls({
  name,
  settings,
  onChange,
  children,
}: {
  name: string
  settings: PeerAudioSettings
  onChange: (patch: Partial<PeerAudioSettings>) => void
  children: React.ReactNode
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-56 p-3">
        <p className="mb-2 truncate text-xs font-semibold text-foreground">{name}</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onChange({ muted: !settings.muted })}
            aria-label={settings.muted ? `Unmute ${name} for me` : `Mute ${name} for me`}
            className={cn('shrink-0 text-muted-foreground hover:text-foreground', settings.muted && 'text-destructive')}
          >
            {settings.muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.volume}
            disabled={settings.muted}
            aria-label={`Volume for ${name}`}
            onChange={(event) => onChange({ volume: Number(event.target.value) })}
            className="h-1 w-full accent-indigo-500"
          />
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">Only affects what you hear.</p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
```

If `@/components/ui/dropdown-menu` does not export those three names, read the
file and use whatever it does export — do not add a dependency.

- [ ] **Step 4: Make avatars clickable**

In `src/components/flows/huddle-bar.tsx`, add props `peerAudio?: Map<string, PeerAudioSettings>` and `onPeerAudioChange?: (clientId: string, patch: Partial<PeerAudioSettings>) => void`, import `HuddleMemberControls` and the type.

Wrap each member avatar. Keep the existing `<span>` and its classes exactly as
they are, wrapping it in a `<button>` inside the popover trigger — and skip the
wrapper for yourself, since you cannot turn your own playback down:

```tsx
            {members.slice(0, 6).map((member) => {
              const avatar = ( /* the existing <span> for this member, unchanged */ )
              if (!onPeerAudioChange || member.clientId === selfClientId) return avatar
              return (
                <HuddleMemberControls
                  key={member.clientId}
                  name={member.name}
                  settings={peerAudio?.get(member.clientId) ?? { volume: 1, muted: false }}
                  onChange={(patch) => onPeerAudioChange(member.clientId, patch)}
                >
                  <button type="button" className="rounded-full">{avatar}</button>
                </HuddleMemberControls>
              )
            })}
```

This needs a `selfClientId?: string` prop on `HuddleBar`; pass `selfClientId`
from the page.

- [ ] **Step 5: Write the popover test**

Create `src/components/flows/__tests__/huddle-member-controls.test.tsx`:

```tsx
import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen } from '@testing-library/react'
import { act } from 'react'
import { HuddleMemberControls } from '../huddle-member-controls'

test('the slider reflects current volume and reports changes', async () => {
  const patches: Record<string, unknown>[] = []
  render(
    <HuddleMemberControls name="Ada" settings={{ volume: 0.5, muted: false }} onChange={(p) => patches.push(p)}>
      <button type="button">Ada</button>
    </HuddleMemberControls>,
  )
  await act(async () => { screen.getByText('Ada').click() })
  const slider = screen.getByLabelText('Volume for Ada') as HTMLInputElement
  assert.equal(slider.value, '0.5')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(slider, '0.2')
    slider.dispatchEvent(new Event('change', { bubbles: true }))
  })
  assert.deepEqual(patches.at(-1), { volume: 0.2 })
  cleanup()
})

test('local mute is offered and labelled as affecting only me', async () => {
  const patches: Record<string, unknown>[] = []
  render(
    <HuddleMemberControls name="Ada" settings={{ volume: 1, muted: false }} onChange={(p) => patches.push(p)}>
      <button type="button">Ada</button>
    </HuddleMemberControls>,
  )
  await act(async () => { screen.getByText('Ada').click() })
  await act(async () => { screen.getByLabelText('Mute Ada for me').click() })
  assert.deepEqual(patches.at(-1), { muted: true })
  assert.ok(screen.getByText(/only affects what you hear/i))
  cleanup()
})
```

If the Radix menu does not open under jsdom via `.click()`, render
`HuddleMemberControls` with the menu forced open using whatever prop the local
dropdown wrapper supports, rather than weakening the assertions.

- [ ] **Step 6: Run tests, gate, commit**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/__tests__/huddle-member-controls.test.tsx`
Expected: PASS — 2 tests.

Run: `npm run typecheck && npm run lint`
Expected: 0 errors, no new warnings.

```bash
git add src/lib/flows/use-flow-huddle.ts src/components/flows/huddle-member-controls.tsx src/components/flows/huddle-bar.tsx src/components/flows/__tests__/huddle-member-controls.test.tsx "src/app/flows/[id]/page.tsx"
git commit -m "feat(flows): per-peer volume and local mute; fix orphaned audio element on retrack"
```

---

### Task 4: Device list policy

**Files:**
- Create: `src/lib/flows/audio-devices.ts`
- Test: `src/lib/flows/__tests__/audio-devices.test.ts`

**Interfaces:**
- Produces: `type DeviceOption = { deviceId: string; label: string }`, `partitionDevices(devices): { inputs: DeviceOption[]; outputs: DeviceOption[] }`

- [ ] **Step 1: Write the failing test**

Create `src/lib/flows/__tests__/audio-devices.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { partitionDevices } from '../audio-devices'

const device = (kind: string, deviceId: string, label = '') =>
  ({ kind, deviceId, label, groupId: '' }) as MediaDeviceInfo

test('inputs and outputs are separated and video is ignored', () => {
  const { inputs, outputs } = partitionDevices([
    device('audioinput', 'mic-1', 'Built-in Mic'),
    device('audiooutput', 'spk-1', 'Built-in Speakers'),
    device('videoinput', 'cam-1', 'Webcam'),
  ])
  assert.deepEqual(inputs, [{ deviceId: 'mic-1', label: 'Built-in Mic' }])
  assert.deepEqual(outputs, [{ deviceId: 'spk-1', label: 'Built-in Speakers' }])
})

test('entries with no deviceId are dropped — they appear before permission', () => {
  const { inputs } = partitionDevices([device('audioinput', ''), device('audioinput', 'mic-2', 'USB')])
  assert.deepEqual(inputs, [{ deviceId: 'mic-2', label: 'USB' }])
})

test('unlabelled devices get a positional fallback, not a blank row', () => {
  const { inputs, outputs } = partitionDevices([
    device('audioinput', 'mic-1'),
    device('audioinput', 'mic-2'),
    device('audiooutput', 'spk-1'),
  ])
  assert.deepEqual(inputs.map((i) => i.label), ['Microphone 1', 'Microphone 2'])
  assert.deepEqual(outputs.map((o) => o.label), ['Speaker 1'])
})

test('an empty list yields empty lists, not undefined', () => {
  assert.deepEqual(partitionDevices([]), { inputs: [], outputs: [] })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/audio-devices.test.ts`
Expected: FAIL — cannot find module `../audio-devices`.

- [ ] **Step 3: Implement**

Create `src/lib/flows/audio-devices.ts`:

```ts
export type DeviceOption = { deviceId: string; label: string }

/**
 * Splits enumerateDevices() output into pickable audio inputs and outputs.
 *
 * Two quirks of the browser API are handled here rather than in the UI: before
 * microphone permission is granted the list contains entries with an empty
 * deviceId (unusable), and labels are empty strings (unreadable). Both would
 * otherwise render as blank, unselectable rows.
 */
export function partitionDevices(devices: MediaDeviceInfo[]): {
  inputs: DeviceOption[]
  outputs: DeviceOption[]
} {
  const pick = (kind: MediaDeviceKind, fallback: string): DeviceOption[] =>
    devices
      .filter((device) => device.kind === kind && device.deviceId)
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `${fallback} ${index + 1}`,
      }))

  return {
    inputs: pick('audioinput', 'Microphone'),
    outputs: pick('audiooutput', 'Speaker'),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/audio-devices.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/audio-devices.ts src/lib/flows/__tests__/audio-devices.test.ts
git commit -m "feat(flows): audio device list policy"
```

---

### Task 5: Device selection in the huddle

**Files:**
- Modify: `src/lib/flows/use-flow-huddle.ts`
- Create: `src/components/flows/huddle-settings-menu.tsx`
- Modify: `src/components/flows/huddle-bar.tsx`
- Modify: `src/app/flows/[id]/page.tsx`

**Interfaces:**
- Consumes: `partitionDevices`, `DeviceOption` from Task 4; `micEnabled` from Task 1.
- Produces: `useFlowHuddle` additionally returns `devices: { inputs: DeviceOption[]; outputs: DeviceOption[] }`, `inputDeviceId: string | null`, `outputDeviceId: string | null`, `canSelectOutput: boolean`, `selectInputDevice(id): Promise<void>`, `selectOutputDevice(id): Promise<void>`.

- [ ] **Step 1: Enumerate devices**

In `src/lib/flows/use-flow-huddle.ts` add:

```ts
import { partitionDevices, type DeviceOption } from '@/lib/flows/audio-devices'
```

```ts
  const [devices, setDevices] = useState<{ inputs: DeviceOption[]; outputs: DeviceOption[] }>({ inputs: [], outputs: [] })
  const [inputDeviceId, setInputDeviceId] = useState<string | null>(null)
  const [outputDeviceId, setOutputDeviceId] = useState<string | null>(null)
  // Chrome/Edge only. A visible but inert picker is worse than none.
  const canSelectOutput = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype
```

```ts
  // Labels are empty until mic permission is granted, so this only runs once
  // joined, and re-runs when hardware changes mid-call.
  useEffect(() => {
    if (!joined) return
    let cancelled = false
    const refresh = async () => {
      try {
        const list = await navigator.mediaDevices.enumerateDevices()
        if (!cancelled) setDevices(partitionDevices(list))
      } catch { /* leave the lists empty; the menu renders nothing */ }
    }
    void refresh()
    navigator.mediaDevices.addEventListener?.('devicechange', refresh)
    return () => {
      cancelled = true
      navigator.mediaDevices.removeEventListener?.('devicechange', refresh)
    }
  }, [joined])
```

- [ ] **Step 2: Switch input without dropping anyone**

```ts
  const selectInputDevice = useCallback(async (deviceId: string) => {
    try {
      const next = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } })
      const track = next.getAudioTracks()[0]
      if (!track) return
      // replaceTrack needs no renegotiation, so nobody drops mid-sentence.
      await Promise.all(
        Array.from(peers.current.values()).map(async ({ pc }) => {
          const sender = pc.getSenders().find((s) => s.track?.kind === 'audio')
          if (sender) await sender.replaceTrack(track)
        }),
      )
      localStream.current?.getTracks().forEach((t) => t.stop())
      localStream.current = next
      localAnalyser.current = attachAnalyser(next)
      // Re-apply, or switching mics while muted would quietly unmute you.
      track.enabled = micEnabled(muted, pttEnabled, pttHeld)
      setInputDeviceId(deviceId)
    } catch (mediaError) {
      setError(describeMediaError(mediaError))
    }
  }, [attachAnalyser, muted, pttEnabled, pttHeld])
```

- [ ] **Step 3: Switch output**

```ts
  const selectOutputDevice = useCallback(async (deviceId: string) => {
    if (!canSelectOutput) return
    setOutputDeviceId(deviceId)
    await Promise.all(
      Array.from(peers.current.values()).map(async (entry) => {
        const sink = entry.audio as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null
        try { await sink?.setSinkId?.(deviceId) } catch { /* device vanished */ }
      }),
    )
  }, [canSelectOutput])
```

Apply the stored choice to elements created later — in `ontrack`, right after
`applyPeerAudio(peerId)`:

```ts
        if (outputDeviceIdRef.current) {
          void (audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> })
            .setSinkId?.(outputDeviceIdRef.current).catch(() => {})
        }
```

backed by a ref kept in sync so `createPeer` need not depend on the state:

```ts
  const outputDeviceIdRef = useRef<string | null>(null)
  outputDeviceIdRef.current = outputDeviceId
```

Return all six new values from the hook.

- [ ] **Step 4: Build the settings menu**

Create `src/components/flows/huddle-settings-menu.tsx`:

```tsx
'use client'

import { Settings } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { DeviceOption } from '@/lib/flows/audio-devices'

/** Microphone and speaker selection. The speaker select is omitted entirely
 *  where setSinkId is unsupported (Safari, Firefox) rather than shown inert. */
export function HuddleSettingsMenu({
  inputs,
  outputs,
  inputDeviceId,
  outputDeviceId,
  canSelectOutput,
  onSelectInput,
  onSelectOutput,
}: {
  inputs: DeviceOption[]
  outputs: DeviceOption[]
  inputDeviceId: string | null
  outputDeviceId: string | null
  canSelectOutput: boolean
  onSelectInput: (deviceId: string) => void
  onSelectOutput: (deviceId: string) => void
}) {
  if (inputs.length === 0 && outputs.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Audio settings" className="rounded-full p-1.5 text-muted-foreground hover:text-foreground">
          <Settings className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-64 p-3 text-xs">
        <label className="mb-1 block font-semibold text-foreground" htmlFor="huddle-mic">Microphone</label>
        <select
          id="huddle-mic"
          value={inputDeviceId ?? ''}
          onChange={(event) => onSelectInput(event.target.value)}
          className="mb-3 w-full rounded-md border border-border bg-background px-2 py-1"
        >
          {!inputDeviceId && <option value="">System default</option>}
          {inputs.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
        </select>
        {canSelectOutput && outputs.length > 0 && (
          <>
            <label className="mb-1 block font-semibold text-foreground" htmlFor="huddle-speaker">Speakers</label>
            <select
              id="huddle-speaker"
              value={outputDeviceId ?? ''}
              onChange={(event) => onSelectOutput(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-2 py-1"
            >
              {!outputDeviceId && <option value="">System default</option>}
              {outputs.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
            </select>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
```

- [ ] **Step 5: Mount it and pass props**

Render `<HuddleSettingsMenu ... />` in `huddle-bar.tsx` between the PTT control
and the Leave button, gated on `joined`. Add a single optional prop object to
`HuddleBar` rather than seven loose props:

```ts
  audioSettings?: {
    inputs: DeviceOption[]
    outputs: DeviceOption[]
    inputDeviceId: string | null
    outputDeviceId: string | null
    canSelectOutput: boolean
    onSelectInput: (deviceId: string) => void
    onSelectOutput: (deviceId: string) => void
  }
```

and pass it from the page from the hook's return values.

- [ ] **Step 6: Full gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: 0 errors, no new warnings, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/flows/use-flow-huddle.ts src/components/flows/huddle-settings-menu.tsx src/components/flows/huddle-bar.tsx "src/app/flows/[id]/page.tsx"
git commit -m "feat(flows): microphone and speaker selection in the huddle"
```

---

## Manual verification

Not substitutable by the suite — it covers decision logic, not whether sound moves.

1. Turn on PTT. Hold Space: the control reads "Live" and others hear you. Release: silence.
2. With PTT on, type a space in a step name, the copilot box, and a code block. Nothing transmits in any of them.
3. Hold Space, then Cmd-Tab away without releasing. You stop transmitting.
4. Turn a teammate's volume down mid-call; confirm it takes effect. Have them drop wifi for 3s and return — the volume you set must still be applied.
5. Switch microphone mid-call: nobody drops, and if you were muted you stay muted.
6. Switch speakers on Chrome and confirm audio moves. Open the same menu on Safari and confirm the speaker select is absent rather than inert.

## Out of scope

SFU migration beyond ~6 participants; huddle transcript feeding the copilot; noise suppression tuning; volume persisted across sessions.
