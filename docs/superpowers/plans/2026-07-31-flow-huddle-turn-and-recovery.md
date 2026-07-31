# Flow Huddle TURN and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the flow voice huddle dependable — route media through a Cloudflare TURN relay when a direct connection is impossible, and surface (rather than swallow) microphone denials and peer drops.

**Architecture:** The huddle already works: an audio-only WebRTC mesh over the private `flow:<id>` Supabase Realtime topic, with signaling policy isolated as a pure reducer in `huddle-signals.ts` and side effects in `useFlowHuddle`. This plan extends that same split — two new pure modules (`media-errors.ts`, `peer-recovery.ts`) hold the new policy, the hook performs the effects, and the ICE endpoint gains a Cloudflare tier in front of the existing env-based one. The signaling protocol does not change.

**Tech Stack:** Next.js 15 (App Router), React 18, TypeScript, Supabase Realtime, WebRTC, `node:test` + `tsx`, Testing Library, Tailwind.

**Spec:** `docs/superpowers/specs/2026-07-31-flow-huddle-turn-and-recovery-design.md`

## Global Constraints

- **Tests** use `node:test` + `node:assert/strict`. They must live under a `__tests__` directory or the runner glob will not find them. React tests are `.test.tsx` and must `import '@/test-support/jsdom-env'` as their FIRST line.
- **Run one test file:** `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <path>`
- **Run the full gate:** `npm run typecheck && npm run lint && npm test`
- **`npm run build` fails locally by design** (no Supabase env vars). Do not treat it as a regression; the build is validated on Vercel.
- **The `@/` path alias works in both source and tests.** Existing test files use both `@/...` and relative imports; prefer `@/...` for cross-directory imports.
- **No raw token syntax** (`{{...}}`) in any user-facing string, ever. User-facing copy is plain English.
- **Never log or return TURN credentials.** They are server-side only and reach the client solely as the ICE payload of the authenticated endpoint.
- **Commit after each task.** Direct to `main` is the norm in this repo.

---

### Task 1: Cloudflare ICE resolution

Adds a Cloudflare tier in front of the existing env-based ICE config. Pure parsing plus an injectable `fetch` seam, so every branch is testable without network access.

**Files:**
- Modify: `src/lib/flows/ice-config.ts` (currently 21 lines; `iceServersFromEnv` stays untouched)
- Test: `src/lib/flows/__tests__/ice-config.test.ts` (extend the existing 2 tests)

**Interfaces:**
- Consumes: `iceServersFromEnv(env)` — already exists, returns `IceServer[]`.
- Produces:
  - `parseCloudflareIceServers(body: unknown): IceServer[] | null`
  - `resolveIceServers(env: IceEnv, options?: { customIdentifier?: string; fetchImpl?: typeof fetch }): Promise<IceServer[]>`
  - `type IceEnv = { CLOUDFLARE_TURN_KEY_ID?: string; CLOUDFLARE_TURN_API_TOKEN?: string; TURN_URL?: string; TURN_USERNAME?: string; TURN_CREDENTIAL?: string }`
  - `CLOUDFLARE_TURN_TTL_SECONDS = 86_400`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/flows/__tests__/ice-config.test.ts`. Merge the second import below into the file's existing `from '../ice-config'` line rather than adding a duplicate:

```ts
import { setErrorReporter, resetErrorReporter } from '@/lib/observability/sentry'
import { parseCloudflareIceServers, resolveIceServers, CLOUDFLARE_TURN_TTL_SECONDS } from '../ice-config'

const CF_ENV = { CLOUDFLARE_TURN_KEY_ID: 'key-1', CLOUDFLARE_TURN_API_TOKEN: 'token-1' }
const CF_BODY = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' },
  ],
}

const okFetch = (body: unknown, calls: unknown[] = []) =>
  (async (url: unknown, init: unknown) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => body } as unknown as Response
  }) as unknown as typeof fetch

test('parseCloudflareIceServers keeps well-formed entries and rejects junk', () => {
  assert.deepEqual(parseCloudflareIceServers(CF_BODY), CF_BODY.iceServers)
  assert.equal(parseCloudflareIceServers(null), null)
  assert.equal(parseCloudflareIceServers({}), null)
  assert.equal(parseCloudflareIceServers({ iceServers: [] }), null)
  assert.equal(parseCloudflareIceServers({ iceServers: [{ nope: 1 }] }), null)
})

test('Cloudflare config is used and the request carries key, token, ttl and identifier', async () => {
  const calls: unknown[] = []
  const servers = await resolveIceServers(CF_ENV, {
    customIdentifier: 'org-42',
    fetchImpl: okFetch(CF_BODY, calls),
  })
  assert.deepEqual(servers, CF_BODY.iceServers)
  const call = calls[0] as { url: string; init: { headers: Record<string, string>; body: string } }
  assert.match(call.url, /\/v1\/turn\/keys\/key-1\/credentials\/generate-ice-servers$/)
  assert.equal(call.init.headers.Authorization, 'Bearer token-1')
  assert.deepEqual(JSON.parse(call.init.body), {
    ttl: CLOUDFLARE_TURN_TTL_SECONDS,
    customIdentifier: 'org-42',
  })
})

test('a failing Cloudflare call falls through to static TURN env', async () => {
  setErrorReporter(() => {})
  const failing = (async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch
  const servers = await resolveIceServers(
    { ...CF_ENV, TURN_URL: 'turn:relay.example.com:3478', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'c' },
    { fetchImpl: failing },
  )
  assert.deepEqual(servers, [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:relay.example.com:3478', username: 'u', credential: 'c' },
  ])
  resetErrorReporter()
})

test('a throwing Cloudflare call with no static env degrades to STUN-only', async () => {
  setErrorReporter(() => {})
  const throwing = (async () => { throw new Error('network down') }) as unknown as typeof fetch
  assert.deepEqual(await resolveIceServers(CF_ENV, { fetchImpl: throwing }), [
    { urls: 'stun:stun.l.google.com:19302' },
  ])
  resetErrorReporter()
})

test('without Cloudflare env the relay is never called', async () => {
  let called = false
  const spy = (async () => { called = true; return {} as Response }) as unknown as typeof fetch
  const servers = await resolveIceServers({}, { fetchImpl: spy })
  assert.equal(called, false)
  assert.deepEqual(servers, [{ urls: 'stun:stun.l.google.com:19302' }])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/ice-config.test.ts`
Expected: FAIL — `parseCloudflareIceServers`/`resolveIceServers` are not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/flows/ice-config.ts` (leave the existing `IceServer` type and `iceServersFromEnv` exactly as they are):

```ts
import { captureError } from '@/lib/observability/sentry'

export type IceEnv = {
  CLOUDFLARE_TURN_KEY_ID?: string
  CLOUDFLARE_TURN_API_TOKEN?: string
  TURN_URL?: string
  TURN_USERNAME?: string
  TURN_CREDENTIAL?: string
}

/**
 * Credentials are consumed when a PEER CONNECTION is created, not only at join:
 * someone joining an hour into a huddle mints a connection against config the
 * others fetched earlier. A short TTL would break only late joiners — a
 * confusing failure. A day is still bounded, which is the point of moving off a
 * static secret.
 */
export const CLOUDFLARE_TURN_TTL_SECONDS = 86_400

const CLOUDFLARE_TIMEOUT_MS = 5_000

/** Defensive parse: an entry is usable only if it has string or string[] urls. */
export function parseCloudflareIceServers(body: unknown): IceServer[] | null {
  if (!body || typeof body !== 'object') return null
  const servers = (body as { iceServers?: unknown }).iceServers
  if (!Array.isArray(servers)) return null
  const usable = servers.filter((entry): entry is IceServer => {
    if (!entry || typeof entry !== 'object') return false
    const urls = (entry as { urls?: unknown }).urls
    return typeof urls === 'string' || (Array.isArray(urls) && urls.length > 0)
  })
  return usable.length ? usable : null
}

/**
 * ICE config, best tier first: Cloudflare short-lived credentials → static
 * TURN_* env → STUN-only. Any Cloudflare failure falls through rather than
 * failing the join, so a relay outage degrades to the previous behaviour
 * instead of breaking the huddle outright.
 */
export async function resolveIceServers(
  env: IceEnv,
  options: { customIdentifier?: string; fetchImpl?: typeof fetch } = {},
): Promise<IceServer[]> {
  const keyId = env.CLOUDFLARE_TURN_KEY_ID
  const token = env.CLOUDFLARE_TURN_API_TOKEN
  if (keyId && token) {
    try {
      const doFetch = options.fetchImpl ?? fetch
      const response = await doFetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ttl: CLOUDFLARE_TURN_TTL_SECONDS,
            ...(options.customIdentifier ? { customIdentifier: options.customIdentifier } : {}),
          }),
          signal: AbortSignal.timeout(CLOUDFLARE_TIMEOUT_MS),
        },
      )
      if (!response.ok) throw new Error(`Cloudflare TURN responded ${response.status}`)
      const parsed = parseCloudflareIceServers(await response.json())
      if (!parsed) throw new Error('Cloudflare TURN returned no usable iceServers')
      return parsed
    } catch (error) {
      // Never include the response body — it carries the credential.
      captureError(error, { scope: 'flows.huddle.ice', provider: 'cloudflare' })
    }
  }
  return iceServersFromEnv(env)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/ice-config.test.ts`
Expected: PASS — 7 tests (2 original + 5 new).

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/ice-config.ts src/lib/flows/__tests__/ice-config.test.ts
git commit -m "feat(flows): Cloudflare short-lived TURN credentials with env and STUN fallback"
```

---

### Task 2: Wire the relay through the endpoint and the hook

Makes Task 1 reachable: the endpoint calls the resolver with the caller's org id, and the client fetches per join instead of caching for the tab's lifetime.

**Files:**
- Modify: `src/app/api/flows/huddle-ice/route.ts` (all 15 lines)
- Modify: `src/lib/flows/use-flow-huddle.ts:124-148` (the `join` callback) and `:37` (the ref comment)

**Interfaces:**
- Consumes: `resolveIceServers` from Task 1; `AuthContext.organizationId` (`src/lib/server/auth.ts:12`).
- Produces: no new exports. `GET /api/flows/huddle-ice` keeps returning `{ success: true, iceServers }`.

- [ ] **Step 1: Rewrite the endpoint**

Replace the whole body of `src/app/api/flows/huddle-ice/route.ts`:

```ts
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { resolveIceServers } from '@/lib/flows/ice-config'

// GET /api/flows/huddle-ice — WebRTC ICE config for the voice huddle.
// Credentials are minted server-side per call (Cloudflare short-lived creds,
// falling back to static TURN_* env, then STUN-only) and reach only
// authenticated users — never the client bundle. The org id is passed as
// Cloudflare's customIdentifier so relay usage is attributable per workspace.
export const GET = withAuthenticatedApi(async (_request, auth) => ({
  success: true,
  iceServers: await resolveIceServers(
    {
      CLOUDFLARE_TURN_KEY_ID: process.env.CLOUDFLARE_TURN_KEY_ID,
      CLOUDFLARE_TURN_API_TOKEN: process.env.CLOUDFLARE_TURN_API_TOKEN,
      TURN_URL: process.env.TURN_URL,
      TURN_USERNAME: process.env.TURN_USERNAME,
      TURN_CREDENTIAL: process.env.TURN_CREDENTIAL,
    },
    { customIdentifier: auth.organizationId },
  ),
}), { permission: 'flow.read' })
```

- [ ] **Step 2: Fetch per join in the hook**

In `src/lib/flows/use-flow-huddle.ts`, replace the ref comment at lines 35-37:

```ts
  // ICE config from the auth-gated endpoint. Fetched on EVERY join (a rare,
  // deliberate gesture) so short-lived credentials cannot go stale in a
  // long-lived tab. Any failure falls back to baked-in STUN.
  const iceServersRef = useRef<RTCIceServer[] | null>(null)
```

Then, inside `join`, replace the cached-fetch block (the `if (!iceServersRef.current) { ... }` wrapper at lines 128-135) with an unconditional fetch:

```ts
      try {
        const res = await fetch('/api/flows/huddle-ice', { cache: 'no-store' })
        const data = await res.json().catch(() => null)
        if (res.ok && Array.isArray(data?.iceServers) && data.iceServers.length) {
          iceServersRef.current = data.iceServers
        }
      } catch { /* keep whatever we had; createPeer falls back to STUN */ }
      iceServersRef.current ??= (RTC_CONFIG.iceServers as RTCIceServer[] | undefined) ?? null
```

- [ ] **Step 3: Verify the route still passes its smoke test**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/route-smoke.test.ts`
Expected: PASS. This test enumerates routes and their permission gates — it catches a wrapper or permission that got dropped in the rewrite.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (If `_request` trips a lint rule, run `npm run lint` and rename per the repo's convention.)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/flows/huddle-ice/route.ts src/lib/flows/use-flow-huddle.ts
git commit -m "feat(flows): mint huddle ICE credentials per join, attributed per workspace"
```

---

### Task 3: Microphone error messages

Pure mapping from a `getUserMedia` rejection to what the user should actually do about it.

**Files:**
- Create: `src/lib/flows/media-errors.ts`
- Test: `src/lib/flows/__tests__/media-errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type MediaErrorInfo = { title: string; hint: string; retryable: boolean }`
  - `describeMediaError(error: unknown): MediaErrorInfo`

- [ ] **Step 1: Write the failing test**

Create `src/lib/flows/__tests__/media-errors.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeMediaError } from '../media-errors'

const named = (name: string) => Object.assign(new Error(name), { name })

test('a denied mic is not retryable and points at the browser control', () => {
  const info = describeMediaError(named('NotAllowedError'))
  assert.equal(info.retryable, false)
  assert.match(info.title, /blocked/i)
  assert.match(info.hint, /address bar/i)
})

test('a missing or busy device is retryable', () => {
  for (const name of ['NotFoundError', 'OverconstrainedError', 'NotReadableError']) {
    assert.equal(describeMediaError(named(name)).retryable, true, name)
  }
  assert.match(describeMediaError(named('NotFoundError')).title, /no microphone/i)
  assert.match(describeMediaError(named('NotReadableError')).title, /in use/i)
})

test('unknown and non-error values fall back to a generic retryable message', () => {
  for (const value of [named('WeirdError'), undefined, null, 'a string', {}]) {
    const info = describeMediaError(value)
    assert.equal(info.retryable, true)
    assert.ok(info.title.length > 0 && info.hint.length > 0)
  }
})

test('no message uses raw token syntax', () => {
  for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'Whatever']) {
    const info = describeMediaError(named(name))
    assert.ok(!/\{\{|\}\}/.test(`${info.title} ${info.hint}`), name)
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/media-errors.test.ts`
Expected: FAIL — cannot find module `../media-errors`.

- [ ] **Step 3: Implement**

Create `src/lib/flows/media-errors.ts`:

```ts
/** What to show when getUserMedia rejects. `retryable: false` means a Retry
 *  button would be a lie — see NotAllowedError below. */
export type MediaErrorInfo = { title: string; hint: string; retryable: boolean }

/**
 * Maps a getUserMedia rejection to plain-English guidance. Pure, so every
 * branch is testable without a browser — the hook only decides WHEN to call it.
 */
export function describeMediaError(error: unknown): MediaErrorInfo {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name: unknown }).name)
      : ''

  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      // A hard deny cannot be re-prompted from script — the user must clear it
      // in browser UI. Offering Retry here would silently do nothing.
      return {
        title: 'Microphone access is blocked',
        hint: 'Allow microphone access from the icon in your browser’s address bar, then join again.',
        retryable: false,
      }
    case 'NotFoundError':
    case 'OverconstrainedError':
      return {
        title: 'No microphone found',
        hint: 'Connect a microphone or headset, then try again.',
        retryable: true,
      }
    case 'NotReadableError':
      return {
        title: 'Your microphone is in use',
        hint: 'Another app has the microphone. Close it, then try again.',
        retryable: true,
      }
    default:
      return {
        title: 'Could not start the huddle',
        hint: 'Something went wrong reaching your microphone. Try again.',
        retryable: true,
      }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/media-errors.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/media-errors.ts src/lib/flows/__tests__/media-errors.test.ts
git commit -m "feat(flows): plain-English microphone failure messages"
```

---

### Task 4: Show the microphone error

Surfaces Task 3 in the UI. Contains a subtle visibility trap — read Step 2 carefully.

**Files:**
- Modify: `src/lib/flows/use-flow-huddle.ts` (the `join` callback and the returned object)
- Modify: `src/components/flows/huddle-bar.tsx`
- Test: `src/components/flows/__tests__/huddle-bar.test.tsx` (create)

**Interfaces:**
- Consumes: `describeMediaError`, `MediaErrorInfo` from Task 3.
- Produces: `useFlowHuddle` returns `error: MediaErrorInfo | null` and `clearError: () => void`, added to the existing `{ joined, connecting, muted, speakingIds, join, leave, toggleMute }`. `HuddleBar` gains props `error?: MediaErrorInfo | null` and `onDismissError?: () => void`.

- [ ] **Step 1: Add error state to the hook**

In `src/lib/flows/use-flow-huddle.ts`:

```ts
import { describeMediaError, type MediaErrorInfo } from '@/lib/flows/media-errors'
```

Add alongside the other state declarations:

```ts
  const [error, setError] = useState<MediaErrorInfo | null>(null)
```

In `join`, clear the previous error at the top (after the `joinedRef` guard):

```ts
    setError(null)
    setConnecting(true)
```

and replace the silent `catch` (currently the comment `// Mic denied or unavailable — stay out of the huddle.`):

```ts
    } catch (mediaError) {
      // Was silently swallowed: the user clicked Join and nothing happened.
      setError(describeMediaError(mediaError))
    } finally {
```

Add `clearError` and widen the return:

```ts
  const clearError = useCallback(() => setError(null), [])

  return { joined, connecting, muted, speakingIds, error, join, leave, toggleMute, clearError }
```

- [ ] **Step 2: Render it in the bar — including the hidden case**

In `src/components/flows/huddle-bar.tsx`, add to the props type:

```ts
  error?: MediaErrorInfo | null
  onDismissError?: () => void
```

with `import type { MediaErrorInfo } from '@/lib/flows/media-errors'` and `AlertCircle`, `X` added to the existing `lucide-react` import.

**The trap:** the current early return is `if (!joined && members.length === 0) return null`. The first person to start a huddle does so from the jam dialog (`page.tsx:2361`) while `members` is empty — so if their mic is denied, `joined` stays false, `members` stays empty, and the bar renders `null`. The error would be invisible in exactly the case it matters most. The guard must account for it:

```ts
  if (!joined && members.length === 0 && !error) return null
```

Then wrap the existing bar so the error sits above it. Replace the single root `<div className="absolute bottom-4 ...">` with:

```tsx
  return (
    <div className="absolute bottom-4 left-1/2 z-40 flex -translate-x-1/2 flex-col items-center gap-2">
      {error && (
        <div role="alert" className="flex max-w-sm items-start gap-2 rounded-lg border border-destructive/40 bg-background/95 px-3 py-2 shadow-lg backdrop-blur">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="text-xs">
            <p className="font-semibold text-foreground">{error.title}</p>
            <p className="text-muted-foreground">{error.hint}</p>
          </div>
          <button type="button" onClick={onDismissError} aria-label="Dismiss" className="ml-1 text-muted-foreground hover:text-foreground">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {(joined || members.length > 0) && (
        <div className="flex items-center gap-2 rounded-full border border-border bg-background/95 px-3 py-2 shadow-lg backdrop-blur">
          {/* ...the existing bar contents, unchanged... */}
        </div>
      )}
    </div>
  )
```

Keep the existing header span, avatar list, and button block verbatim inside that inner `<div>`. When `error.retryable` is false, the Join button must not be shown as the fix — the hint carries the instruction; leave the button's existing behaviour alone.

- [ ] **Step 3: Write the test**

Create `src/components/flows/__tests__/huddle-bar.test.tsx`:

```tsx
import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen } from '@testing-library/react'
import { HuddleBar } from '../huddle-bar'

const noop = () => {}
const base = {
  joined: false,
  connecting: false,
  muted: false,
  members: [],
  speakingIds: new Set<string>(),
  onJoin: noop,
  onLeave: noop,
  onToggleMute: noop,
}

test('renders nothing when idle with no error', () => {
  const { container } = render(<HuddleBar {...base} />)
  assert.equal(container.firstChild, null)
  cleanup()
})

test('a mic error is visible even when nobody is in the huddle', () => {
  render(
    <HuddleBar
      {...base}
      error={{ title: 'Microphone access is blocked', hint: 'Allow microphone access from the icon in your browser’s address bar, then join again.', retryable: false }}
      onDismissError={noop}
    />,
  )
  assert.ok(screen.getByRole('alert'))
  assert.ok(screen.getByText('Microphone access is blocked'))
  cleanup()
})

test('members still render the huddle controls', () => {
  render(<HuddleBar {...base} joined members={[{ clientId: 'a', name: 'Ada', color: '#f00' }]} />)
  assert.ok(screen.getByLabelText('Leave huddle'))
  cleanup()
})
```

- [ ] **Step 4: Run the test**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/__tests__/huddle-bar.test.tsx`
Expected: PASS — 3 tests.

- [ ] **Step 5: Pass the props through the page**

In `src/app/flows/[id]/page.tsx` at the `<HuddleBar ... />` usage (around line 2032), add:

```tsx
          error={huddle.error}
          onDismissError={huddle.clearError}
```

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/lib/flows/use-flow-huddle.ts src/components/flows/huddle-bar.tsx src/components/flows/__tests__/huddle-bar.test.tsx src/app/flows/\[id\]/page.tsx
git commit -m "fix(flows): surface microphone failures instead of swallowing them"
```

---

### Task 5: Peer recovery policy

Pure decisions about transient peer drops. No WebRTC here — the hook owns the effects.

**Files:**
- Create: `src/lib/flows/peer-recovery.ts`
- Test: `src/lib/flows/__tests__/peer-recovery.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type PeerAction = 'wait' | 'restart-ice' | 'close'`
  - `nextPeerAction(state: RTCPeerConnectionState, attempts: number, isInitiator: boolean): PeerAction`
  - `recoveryDelayMs(state: RTCPeerConnectionState, attempts: number): number`
  - `PEER_GRACE_MS = 5_000`, `PEER_MAX_RESTARTS = 2`

- [ ] **Step 1: Write the failing test**

Create `src/lib/flows/__tests__/peer-recovery.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextPeerAction, recoveryDelayMs, PEER_GRACE_MS, PEER_MAX_RESTARTS } from '../peer-recovery'

test('healthy states never act', () => {
  for (const state of ['new', 'connecting', 'connected'] as const) {
    assert.equal(nextPeerAction(state, 0, true), 'wait', state)
  }
})

test('only the initiator restarts, so both sides never restart at once', () => {
  assert.equal(nextPeerAction('disconnected', 0, true), 'restart-ice')
  assert.equal(nextPeerAction('disconnected', 0, false), 'wait')
  assert.equal(nextPeerAction('failed', 0, true), 'restart-ice')
  assert.equal(nextPeerAction('failed', 0, false), 'wait')
})

test('the peer is closed once restarts are exhausted, whoever we are', () => {
  assert.equal(nextPeerAction('failed', PEER_MAX_RESTARTS, true), 'close')
  assert.equal(nextPeerAction('failed', PEER_MAX_RESTARTS, false), 'close')
})

test('an explicitly closed connection is always closed out', () => {
  assert.equal(nextPeerAction('closed', 0, true), 'close')
})

test('the first disconnect waits out a grace period; later attempts back off', () => {
  assert.equal(recoveryDelayMs('disconnected', 0), PEER_GRACE_MS)
  assert.equal(recoveryDelayMs('failed', 0), 0) // failed is terminal, no point waiting
  assert.equal(recoveryDelayMs('disconnected', 1), 1_000)
  assert.equal(recoveryDelayMs('disconnected', 2), 4_000)
  assert.equal(recoveryDelayMs('disconnected', 9), 4_000)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/peer-recovery.test.ts`
Expected: FAIL — cannot find module `../peer-recovery`.

- [ ] **Step 3: Implement**

Create `src/lib/flows/peer-recovery.ts`:

```ts
export type PeerAction = 'wait' | 'restart-ice' | 'close'

/** `disconnected` is frequently transient — a wifi blip, a network switch.
 *  Waiting this long before acting avoids tearing down a link that recovers
 *  on its own, which is what the huddle used to do. */
export const PEER_GRACE_MS = 5_000

export const PEER_MAX_RESTARTS = 2

const BACKOFF_MS = [1_000, 4_000]

/**
 * What to do about a peer in trouble. Only the side that originally sent the
 * offer restarts, mirroring the deterministic-initiator rule in
 * huddle-signals.ts — if both sides restarted we would recreate the glare that
 * rule exists to prevent.
 */
export function nextPeerAction(
  state: RTCPeerConnectionState,
  attempts: number,
  isInitiator: boolean,
): PeerAction {
  if (state === 'closed') return 'close'
  if (state !== 'disconnected' && state !== 'failed') return 'wait'
  if (attempts >= PEER_MAX_RESTARTS) return 'close'
  return isInitiator ? 'restart-ice' : 'wait'
}

/** How long to wait before acting: a grace period for the first transient
 *  disconnect, capped backoff after that. `failed` is terminal — no grace. */
export function recoveryDelayMs(state: RTCPeerConnectionState, attempts: number): number {
  if (attempts === 0) return state === 'failed' ? 0 : PEER_GRACE_MS
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/peer-recovery.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/peer-recovery.ts src/lib/flows/__tests__/peer-recovery.test.ts
git commit -m "feat(flows): peer recovery policy — grace period, ICE restart, bounded retries"
```

---

### Task 6: Reconnect dropped peers

Replaces immediate teardown with grace → ICE restart → close, and makes the state visible.

**Files:**
- Modify: `src/lib/flows/use-flow-huddle.ts` (`PeerEntry`, `createPeer`, `closePeer`, the signaling effect, `leave`, the return value)
- Modify: `src/components/flows/huddle-bar.tsx` (per-member state)
- Modify: `src/app/flows/[id]/page.tsx` (pass `peerStates`)
- Test: `src/lib/flows/__tests__/huddle-restart.test.ts`

**Interfaces:**
- Consumes: `nextPeerAction`, `recoveryDelayMs`, `PEER_MAX_RESTARTS` from Task 5; `reduceHuddleSignal` (unchanged).
- Produces: `useFlowHuddle` additionally returns `peerStates: Map<string, PeerConnectionState>` where `type PeerConnectionState = 'connected' | 'reconnecting' | 'lost'`. `HuddleBar` gains prop `peerStates?: Map<string, PeerConnectionState>`.

- [ ] **Step 1: Track the initiator and attempts**

In `src/lib/flows/use-flow-huddle.ts`, widen `PeerEntry` (line 12):

```ts
type PeerEntry = {
  pc: RTCPeerConnection
  audio: HTMLAudioElement | null
  analyser: AnalyserNode | null
  /** Whether WE sent the original offer — only this side restarts ICE. */
  isInitiator: boolean
  attempts: number
  timer: number | null
}
```

`createPeer` takes the flag and stores the new fields:

```ts
  const createPeer = useCallback((peerId: string, isInitiator: boolean): RTCPeerConnection => {
```

and its `peers.current.set` becomes:

```ts
    peers.current.set(peerId, { pc, audio: null, analyser: null, isInitiator, attempts: 0, timer: null })
```

In the signaling effect, the two call sites become `createPeer(instruction.peerId, true)` for `create-offer` and `createPeer(instruction.peerId, false)` for `apply-offer`.

`closePeer` must also clear any pending timer:

```ts
    if (entry.timer !== null) window.clearTimeout(entry.timer)
```

- [ ] **Step 2: Replace immediate teardown with recovery**

Add `peerStates` state next to `speakingIds`:

```ts
  const [peerStates, setPeerStates] = useState<Map<string, PeerConnectionState>>(new Map())

  const setPeerState = useCallback((peerId: string, state: PeerConnectionState | null) => {
    setPeerStates((prev) => {
      const next = new Map(prev)
      if (state === null) next.delete(peerId)
      else next.set(peerId, state)
      return next
    })
  }, [])
```

with `export type PeerConnectionState = 'connected' | 'reconnecting' | 'lost'` declared above the hook.

Add the recovery effect callbacks above `createPeer`:

```ts
  const restartIce = useCallback(async (peerId: string) => {
    const entry = peers.current.get(peerId)
    if (!entry) return
    entry.attempts += 1
    try {
      entry.pc.restartIce()
      const offer = await entry.pc.createOffer()
      await entry.pc.setLocalDescription(offer)
      // A re-offer to a peer we already have: reduceHuddleSignal routes it to
      // the existing connection, so no signaling change was needed.
      send({ kind: 'offer', to: peerId, sdp: offer })
    } catch {
      // The scheduled follow-up evaluates state again and closes if needed.
    }
  }, [send])

  const scheduleRecovery = useCallback((peerId: string) => {
    const entry = peers.current.get(peerId)
    if (!entry || entry.timer !== null) return
    const delay = recoveryDelayMs(entry.pc.connectionState, entry.attempts)
    entry.timer = window.setTimeout(() => {
      const current = peers.current.get(peerId)
      if (!current) return
      current.timer = null
      if (current.pc.connectionState === 'connected') {
        setPeerState(peerId, 'connected')
        current.attempts = 0
        return
      }
      const action = nextPeerAction(current.pc.connectionState, current.attempts, current.isInitiator)
      if (action === 'restart-ice') {
        void restartIce(peerId)
        scheduleRecoveryRef.current(peerId)
      } else if (action === 'close') {
        setPeerState(peerId, 'lost')
        closePeer(peerId)
      }
    }, delay)
  }, [restartIce, closePeer, setPeerState])

  // scheduleRecovery re-schedules itself; a ref breaks the declaration cycle.
  const scheduleRecoveryRef = useRef(scheduleRecovery)
  scheduleRecoveryRef.current = scheduleRecovery
```

Replace the `onconnectionstatechange` handler in `createPeer`:

```ts
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      if (state === 'connected') {
        const entry = peers.current.get(peerId)
        if (entry) {
          entry.attempts = 0
          if (entry.timer !== null) { window.clearTimeout(entry.timer); entry.timer = null }
        }
        setPeerState(peerId, 'connected')
      } else if (state === 'disconnected' || state === 'failed') {
        // Was: closePeer(peerId) — a 2s wifi blip killed the peer for good.
        setPeerState(peerId, 'reconnecting')
        scheduleRecoveryRef.current(peerId)
      } else if (state === 'closed') {
        setPeerState(peerId, null)
        closePeer(peerId)
      }
    }
```

Add the imports:

```ts
import { nextPeerAction, recoveryDelayMs } from '@/lib/flows/peer-recovery'
```

In `leave`, clear the map alongside `setSpeakingIds(new Set())`:

```ts
    setPeerStates(new Map())
```

Return `peerStates` from the hook.

- [ ] **Step 3: Write the restart test**

Create `src/lib/flows/__tests__/huddle-restart.test.ts`. This asserts the property the whole design rests on — a restart offer reaches the EXISTING connection rather than creating a second one:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reduceHuddleSignal } from '../huddle-signals'

test('a re-offer from a known peer is applied to the existing connection', () => {
  // The ICE-restart path: we already have `peer-a`, and it re-offers.
  const instructions = reduceHuddleSignal('self', true, ['peer-a'], {
    kind: 'offer',
    from: 'peer-a',
    to: 'self',
    sdp: { type: 'offer' },
  })
  assert.deepEqual(instructions, [{ action: 'apply-offer', peerId: 'peer-a', sdp: { type: 'offer' } }])
})

test('a restart offer addressed to someone else is ignored', () => {
  assert.deepEqual(
    reduceHuddleSignal('self', true, ['peer-a'], { kind: 'offer', from: 'peer-a', to: 'peer-b', sdp: {} }),
    [],
  )
})
```

- [ ] **Step 4: Run the test**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/huddle-restart.test.ts`
Expected: PASS — 2 tests. (These pass against the unchanged reducer by design: they are a regression guard proving the restart path is already routed correctly.)

- [ ] **Step 5: Show the state in the bar**

In `src/components/flows/huddle-bar.tsx`, add the prop:

```ts
  peerStates?: Map<string, PeerConnectionState>
```

with `import type { PeerConnectionState } from '@/lib/flows/use-flow-huddle'`, and apply it to the avatar span's `className`:

```tsx
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-full border-2 border-background text-[10px] font-semibold text-white transition-shadow',
              speakingIds.has(member.clientId) && 'ring-2 ring-emerald-400',
              peerStates?.get(member.clientId) === 'reconnecting' && 'opacity-50 animate-pulse',
              peerStates?.get(member.clientId) === 'lost' && 'opacity-40 grayscale',
            )}
```

and extend the existing `title` so it reads as an explanation rather than a bare name:

```tsx
            title={
              peerStates?.get(member.clientId) === 'reconnecting' ? `${member.name} — reconnecting`
              : peerStates?.get(member.clientId) === 'lost' ? `${member.name} — connection lost`
              : member.name
            }
```

- [ ] **Step 6: Pass it through the page**

In `src/app/flows/[id]/page.tsx` at the `<HuddleBar ... />` usage, add:

```tsx
          peerStates={huddle.peerStates}
```

- [ ] **Step 7: Run the full gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass. Do NOT run `npm run build` — it fails locally without Supabase env vars, by design.

- [ ] **Step 8: Commit**

```bash
git add src/lib/flows/use-flow-huddle.ts src/components/flows/huddle-bar.tsx src/lib/flows/__tests__/huddle-restart.test.ts src/app/flows/\[id\]/page.tsx
git commit -m "fix(flows): recover dropped huddle peers instead of tearing them down"
```

---

## Manual verification (required before calling this done)

Automated tests cover the policy, not the transport. These steps cannot be run from this environment — they need a real Cloudflare account and a genuinely restrictive network:

1. Create a Cloudflare Realtime TURN key. Set `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN` in Vercel, then redeploy.
2. Open the same flow as two users on different networks, one behind a corporate firewall or symmetric NAT.
3. Join the huddle from both. In `chrome://webrtc-internals`, confirm the selected candidate pair has type `relay` for the constrained peer — that is the proof the relay is carrying media rather than the connection merely surviving.
4. Disable wifi on one machine for ~3 seconds, then re-enable. Confirm the avatar dims and pulses, and audio returns **without** either side leaving and rejoining.
5. In a fresh profile, deny the microphone prompt. Confirm the blocked-mic message appears with no Retry button.

Until step 3 passes, the relay is unproven — the code falls back to STUN and everything else still works, so a green test suite is not evidence TURN functions.

## Out of scope

Carried from the spec, in priority order: huddle-start notifications; push-to-talk and device pickers; per-peer volume and local mute; SFU migration (the mesh degrades past ~6 participants); huddle transcript feeding the flow copilot; server-side credential caching per org.
