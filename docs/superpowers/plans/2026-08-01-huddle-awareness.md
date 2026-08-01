# Huddle Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a started huddle discoverable — a toast for people with the flow open, and an explicit ring for people who don't.

**Architecture:** Both layers are copy and policy decisions, so both live in one new pure module (`huddle-alerts.ts`) tested without a browser or database. The toast reads presence the flow page already subscribes to. The ring adds one optional field to the invite endpoint that already handles rate limiting, tenancy, and audit.

**Tech Stack:** Next.js 15 App Router, React 18, Supabase Realtime presence, Sonner, Zod, Prisma, `node:test` + `tsx`, Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-01-huddle-awareness-design.md`

## Global Constraints

- **Tests** use `node:test` + `node:assert/strict`, must live under `__tests__`, and React tests are `.test.tsx` with `import '@/test-support/jsdom-env'` as the FIRST line.
- **Run one test file:** `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <path>`
- **Full gate:** `npm run typecheck && npm run lint && npm test`. Do NOT run `npm run build` — it fails locally without Supabase env vars, by design.
- **No raw token syntax** (`{{...}}`) in user-facing copy.
- **Existing jam-invite copy must not change.** `kind` defaults to `'jam'`, and the `jam` branch reproduces today's strings exactly.
- **Commit after each task.** Direct to `main`.

---

### Task 1: Alert policy and copy

One pure module for both layers: when to toast, and what a ring says.

**Files:**
- Create: `src/lib/flows/huddle-alerts.ts`
- Test: `src/lib/flows/__tests__/huddle-alerts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type HuddleParticipant = { clientId: string; name: string; inHuddle?: boolean }`
  - `detectHuddleStart(prev, next, selfClientId, selfJoined): string | null`
  - `type RingKind = 'jam' | 'huddle'`
  - `ringNotification(kind, inviterName, flowName, flowId): { type: string; level: 'action'; title: string; body: string; link: string }`

- [ ] **Step 1: Write the failing test**

Create `src/lib/flows/__tests__/huddle-alerts.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectHuddleStart, ringNotification, type HuddleParticipant } from '../huddle-alerts'

const p = (clientId: string, name: string, inHuddle = false): HuddleParticipant => ({ clientId, name, inHuddle })

test('a huddle starting names the person who started it', () => {
  const prev = [p('a', 'Ada'), p('b', 'Bo')]
  const next = [p('a', 'Ada', true), p('b', 'Bo')]
  assert.equal(detectHuddleStart(prev, next, 'me', false), 'Ada')
})

test('later joiners are silent — one toast per huddle, not one per person', () => {
  const prev = [p('a', 'Ada', true), p('b', 'Bo')]
  const next = [p('a', 'Ada', true), p('b', 'Bo', true)]
  assert.equal(detectHuddleStart(prev, next, 'me', false), null)
})

test('two people flipping in the same tick is still one start', () => {
  const prev = [p('a', 'Ada'), p('b', 'Bo')]
  const next = [p('a', 'Ada', true), p('b', 'Bo', true)]
  assert.equal(detectHuddleStart(prev, next, 'me', false), 'Ada')
})

test('being in the huddle yourself suppresses the toast', () => {
  const prev = [p('a', 'Ada')]
  const next = [p('a', 'Ada', true)]
  assert.equal(detectHuddleStart(prev, next, 'me', true), null)
})

test('your own presence never counts as someone else starting', () => {
  // Self is filtered out, so the ordering of setJoined/setInHuddle cannot matter.
  const prev = [p('me', 'Me')]
  const next = [p('me', 'Me', true)]
  assert.equal(detectHuddleStart(prev, next, 'me', false), null)
})

test('no change and empty rooms are silent', () => {
  assert.equal(detectHuddleStart([], [], 'me', false), null)
  const same = [p('a', 'Ada', true)]
  assert.equal(detectHuddleStart(same, same, 'me', false), null)
})

test('a huddle ending then restarting toasts again', () => {
  const live = [p('a', 'Ada', true)]
  const ended = [p('a', 'Ada')]
  assert.equal(detectHuddleStart(live, ended, 'me', false), null)
  assert.equal(detectHuddleStart(ended, live, 'me', false), 'Ada')
})

test('jam copy is unchanged from what the endpoint sends today', () => {
  const out = ringNotification('jam', 'Ada', 'Weekly rollup', 'f1')
  assert.equal(out.type, 'flow.jam_invite')
  assert.equal(out.title, 'Ada invited you to jam')
  assert.equal(out.body, 'Join “Weekly rollup” to edit it together in real time.')
  assert.equal(out.link, '/flows/f1')
  assert.equal(out.level, 'action')
})

test('huddle copy names the huddle and links to the flow', () => {
  const out = ringNotification('huddle', 'Ada', 'Weekly rollup', 'f1')
  assert.equal(out.type, 'flow.huddle_started')
  assert.equal(out.title, 'Ada started a huddle')
  assert.match(out.body, /voice huddle/i)
  assert.equal(out.link, '/flows/f1')
})

test('no copy uses raw token syntax', () => {
  for (const kind of ['jam', 'huddle'] as const) {
    const out = ringNotification(kind, 'Ada', 'Flow', 'f1')
    assert.ok(!/\{\{|\}\}/.test(`${out.title} ${out.body}`), kind)
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/huddle-alerts.test.ts`
Expected: FAIL — cannot find module `../huddle-alerts`.

- [ ] **Step 3: Implement**

Create `src/lib/flows/huddle-alerts.ts`:

```ts
/** The slice of CollabParticipant this policy needs. */
export type HuddleParticipant = { clientId: string; name: string; inHuddle?: boolean }

export type RingKind = 'jam' | 'huddle'

const inHuddleOthers = (list: HuddleParticipant[], selfClientId: string) =>
  list.filter((participant) => participant.inHuddle && participant.clientId !== selfClientId)

/**
 * Names the person who just started a huddle, or null when there is nothing to
 * announce. Fires only on the ZERO-TO-ONE transition, so a five-person huddle
 * produces one toast rather than one per joiner.
 *
 * Self is filtered from both sides, which is why the ordering of setJoined and
 * setInHuddle inside join() cannot produce a phantom "someone started" toast
 * for your own huddle.
 */
export function detectHuddleStart(
  prev: HuddleParticipant[],
  next: HuddleParticipant[],
  selfClientId: string,
  selfJoined: boolean,
): string | null {
  if (selfJoined) return null // you are in it; the bar is right there
  if (inHuddleOthers(prev, selfClientId).length > 0) return null
  const starters = inHuddleOthers(next, selfClientId)
  return starters.length > 0 ? starters[0].name : null
}

/**
 * Copy for a ring. The `jam` branch reproduces exactly what the invite endpoint
 * sent before `kind` existed — changing it would silently alter every existing
 * invite notification.
 */
export function ringNotification(
  kind: RingKind,
  inviterName: string,
  flowName: string,
  flowId: string,
): { type: string; level: 'action'; title: string; body: string; link: string } {
  const link = `/flows/${flowId}`
  if (kind === 'huddle') {
    return {
      type: 'flow.huddle_started',
      level: 'action',
      title: `${inviterName} started a huddle`,
      body: `Join the voice huddle on “${flowName}”.`,
      link,
    }
  }
  return {
    type: 'flow.jam_invite',
    level: 'action',
    title: `${inviterName} invited you to jam`,
    body: `Join “${flowName}” to edit it together in real time.`,
    link,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/huddle-alerts.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/huddle-alerts.ts src/lib/flows/__tests__/huddle-alerts.test.ts
git commit -m "feat(flows): huddle alert policy and ring copy"
```

---

### Task 2: Ring through the invite endpoint

Adds `kind` to the endpoint, routing copy through Task 1 and distinguishing the audit trail.

**Files:**
- Modify: `src/app/api/flows/[id]/invite/route.ts`

**Interfaces:**
- Consumes: `ringNotification`, `RingKind` from Task 1.
- Produces: `POST /api/flows/[id]/invite` accepts optional `kind: 'jam' | 'huddle'` (default `'jam'`). Response shape `{ success: true, invited: number }` is unchanged.

- [ ] **Step 1: Extend the body schema**

In `src/app/api/flows/[id]/invite/route.ts`:

```ts
const bodySchema = z.object({
  userIds: z.array(z.string().min(1)).min(1).max(50),
  // Defaulted so every existing caller keeps today's jam-invite behaviour.
  kind: z.enum(['jam', 'huddle']).default('jam'),
})
```

and add the import:

```ts
import { ringNotification } from '@/lib/flows/huddle-alerts'
```

- [ ] **Step 2: Route the copy through the helper**

Replace the destructure and the `notify` block:

```ts
  const { userIds, kind } = bodySchema.parse(await request.json())
```

```ts
  const inviterName = auth.dbUser.name || auth.dbUser.email || 'A teammate'
  const copy = ringNotification(kind, inviterName, flow.name, flow.id)
  await Promise.all(
    recipients.map((r) =>
      notify({
        organizationId: auth.organizationId,
        userId: r.id,
        type: copy.type,
        level: copy.level,
        title: copy.title,
        body: copy.body,
        link: copy.link,
      }),
    ),
  )
```

- [ ] **Step 3: Distinguish the audit action**

In the `recordAudit` call, replace the fixed action:

```ts
    action: kind === 'huddle' ? 'flow.huddle_ring' : 'flow.invited',
```

and add `kind` to the detail object:

```ts
    detail: { invited: recipients.map((r) => r.id), kind },
```

- [ ] **Step 4: Verify the route still passes its smoke test**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/route-smoke.test.ts`
Expected: PASS — the permission gate and wrapper are unchanged.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add "src/app/api/flows/[id]/invite/route.ts"
git commit -m "feat(flows): ring teammates to a huddle through the invite endpoint"
```

---

### Task 3: Toast on the page, ring from the dialog

Wires both layers into the UI.

**Files:**
- Modify: `src/app/flows/[id]/page.tsx` (near the existing huddle wiring around line 629)
- Modify: `src/components/flows/jam-dialog.tsx` (`sendInvites`, the send button label)
- Test: `src/components/flows/__tests__/jam-ring.test.tsx` (create)

**Interfaces:**
- Consumes: `detectHuddleStart` from Task 1; `huddle.join`, `huddle.joined`, `participants`, `selfClientId` already present on the page.
- Produces: no new exports.

- [ ] **Step 1: Add the toast effect to the page**

In `src/app/flows/[id]/page.tsx`, add the import:

```ts
import { detectHuddleStart } from '@/lib/flows/huddle-alerts'
```

and, immediately after the `huddleMembers` memo, add:

```tsx
  // Toast when a huddle starts while we're on the page but not in it. The ref
  // is seeded from the FIRST presence snapshot, so opening a flow that already
  // has a huddle running does not claim it just "started" — the huddle bar
  // already covers that case.
  const prevParticipantsRef = useRef<typeof participants | null>(null)
  useEffect(() => {
    const prev = prevParticipantsRef.current
    prevParticipantsRef.current = participants
    if (!prev) return // first snapshot: seed only
    const starter = detectHuddleStart(prev, participants, selfClientId, huddle.joined)
    if (!starter) return
    toast(`${starter} started a huddle`, {
      description: 'Voice chat is live on this flow.',
      action: { label: 'Join', onClick: () => void huddle.join() },
    })
  }, [participants, selfClientId, huddle.joined, huddle.join])
```

`toast` from `sonner`, `useRef`/`useEffect` from `react` — check the existing imports at the top of the file and add only what is missing.

- [ ] **Step 2: Send `kind` from the dialog**

In `src/components/flows/jam-dialog.tsx`, in `sendInvites`, replace the body and success toast:

```ts
        body: JSON.stringify({ userIds: Array.from(selected), kind: huddleJoined ? 'huddle' : 'jam' }),
```

```ts
      toast.success(
        huddleJoined
          ? `Rang ${data.invited} ${data.invited === 1 ? 'person' : 'people'} — they’ll get a notification to join the huddle.`
          : `Invited ${data.invited} ${data.invited === 1 ? 'person' : 'people'} — they’ll get a notification linking to this flow.`,
      )
```

- [ ] **Step 3: Relabel the send button**

Replace the button's label expression (currently the `selected.size === 0 ? 'Select teammates to invite' : ...` ternary):

```tsx
                {selected.size === 0
                  ? (huddleJoined ? 'Select teammates to ring' : 'Select teammates to invite')
                  : huddleJoined
                    ? `Ring ${selected.size} ${selected.size === 1 ? 'teammate' : 'teammates'} to the huddle`
                    : `Send invite to ${selected.size} ${selected.size === 1 ? 'teammate' : 'teammates'}`}
```

- [ ] **Step 4: Write the test**

The existing `jam-invite.test.tsx` does NOT post to the flow-invite endpoint — it only covers the workspace-invitation POST. So the default-`kind` guarantee needs its own coverage.

Create `src/components/flows/__tests__/jam-ring.test.tsx`:

```tsx
import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen } from '@testing-library/react'
import { act } from 'react'
import { JamDialog } from '@/components/flows/jam-dialog'

const flush = async () => { await act(async () => { await Promise.resolve() }) }

const baseProps = {
  open: true as const,
  onOpenChange: () => {},
  flowId: 'f1',
  flowName: 'Flow',
  visibility: 'shared' as const,
  canEdit: true,
  onChangeVisibility: () => {},
}

/** Roster with one other member, capturing POSTs to the flow-invite endpoint. */
function stubRoster(posts: { url: string; body: Record<string, unknown> }[]) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url: String(url), body: JSON.parse(String(init.body)) })
      return { ok: true, json: async () => ({ success: true, invited: 1 }) }
    }
    return {
      ok: true,
      json: async () => ({
        success: true,
        selfId: 'me',
        members: [
          { id: 'me', name: 'Me', email: 'me@x.test', role: 'ADMIN' },
          { id: 'u2', name: 'Ada', email: 'ada@x.test', role: 'USER' },
        ],
      }),
    }
  }) as unknown as typeof fetch
}

const selectAdaAndSend = async () => {
  await act(async () => { screen.getByText('Ada').click() })
  await act(async () => {
    screen.getByRole('button', { name: /ring|send invite/i }).click()
    await Promise.resolve()
  })
}

test('with no huddle live the dialog still sends a plain jam invite', async () => {
  const posts: { url: string; body: Record<string, unknown> }[] = []
  stubRoster(posts)
  render(<JamDialog {...baseProps} />)
  await flush()
  await selectAdaAndSend()
  const invite = posts.find((post) => post.url.includes('/invite'))
  assert.ok(invite, 'posted to the flow invite endpoint')
  assert.equal(invite!.body.kind, 'jam')
  cleanup()
})

test('while in a huddle the same button rings instead of inviting', async () => {
  const posts: { url: string; body: Record<string, unknown> }[] = []
  stubRoster(posts)
  render(<JamDialog {...baseProps} huddleJoined />)
  await flush()
  assert.ok(screen.getByRole('button', { name: /select teammates to ring/i }))
  await selectAdaAndSend()
  const invite = posts.find((post) => post.url.includes('/invite'))
  assert.ok(invite)
  assert.equal(invite!.body.kind, 'huddle')
  cleanup()
})
```

If the member row is not clickable by its name text, read the roster markup in `jam-dialog.tsx` around line 329 and select by the checkbox's accessible name instead. Do not change the component to suit the test.

- [ ] **Step 5: Run the new and existing dialog tests**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/__tests__/jam-ring.test.tsx src/components/flows/__tests__/jam-invite.test.tsx`
Expected: PASS — 2 new tests, 7 existing ones still green.

- [ ] **Step 6: Run the full gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass. Do NOT run `npm run build`.

- [ ] **Step 7: Commit**

```bash
git add "src/app/flows/[id]/page.tsx" src/components/flows/jam-dialog.tsx src/components/flows/__tests__/jam-ring.test.tsx
git commit -m "feat(flows): toast when a huddle starts, ring teammates from the jam dialog"
```

---

## Manual verification

1. Two browser profiles on the same flow. Start a huddle in A; B toasts once, and its Join button puts B in the huddle.
2. A third participant joins; B does not toast again.
3. Reload B while the huddle is live; B does NOT toast (seeded ref), but the huddle bar is visible.
4. From A's jam dialog while in the huddle, ring B; B's notification bell shows huddle copy and the link opens the flow.
5. With no huddle live, send a normal invite and confirm the copy is unchanged from before this work.

## Out of scope

Push-to-talk and device pickers; per-peer volume and local mute; SFU migration; huddle transcript feeding the copilot; server-side ICE credential caching; huddle-start sound.
