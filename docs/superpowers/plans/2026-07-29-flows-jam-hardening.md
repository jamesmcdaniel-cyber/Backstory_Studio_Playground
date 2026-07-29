# Flows Jam Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it possible for two people to be in the same flow jam at the same time — invited, joined, seeing each other's cursors and edits — on a realtime channel that Postgres authorizes.

**Architecture:** Three independent workstreams shipped in order. **A** fixes the join path (middleware `return_to` preservation, invite `next` deep-links, email invites from the Jam dialog, honest share links, real join errors). **C** fixes co-presence (cursor pruning, trailing flush, cross-view follow, live drag). **B** replaces the public realtime channel with two private topics (`flow:<id>` for presence/cursors/huddle, `flow:<id>:ops` for graph edits with INSERT restricted to editors) guarded by RLS policies on `realtime.messages`, and splits the 343-line collab hook into focused units with a connection-status machine.

**Tech Stack:** Next.js 15 (App Router), React 18, TypeScript, Prisma 6 + Postgres (Supabase), Supabase Realtime (`@supabase/supabase-js` 2.50, `@supabase/ssr` 0.6), `@xyflow/react` 12, `node:test` + `@testing-library/react` for jsdom component tests.

## Global Constraints

- **No raw token syntax in UI copy.** Never render `{{...}}` in any user-facing string. Plain-English chips + explicit validation messages.
- **Tests run under `npm test`** — `node:test` with `tsx`, files must live in a `__tests__` directory and end in `.test.ts` / `.test.tsx`. jsdom component tests must `import '@/test-support/jsdom-env'` as their **first** import.
- **Local gate:** `npm run typecheck && npm run lint && npm test`. The local env has **no Supabase vars and no DATABASE_URL** — `npm run build` and any DB-backed test cannot run locally; those are validated in CI-mode (`ci_repro` local Postgres) and on Vercel.
- **New authenticated GET routes must be added to `src/app/api/__tests__/route-smoke.test.ts`** (`cases` or `skipped`) or its completeness test fails.
- **Cross-org by-id lookups must use `systemPrisma`**, with `resolveFlowRole` as the access boundary. Tenant-scoped queries use `prisma`.
- **Commit after every task.** Direct-to-main pushes are the norm for this repo; do not open PRs.
- Existing public API of `useFlowCollab` (its return shape) must not change — `src/app/flows/[id]/page.tsx` consumes it and is not being rewritten.

---

## File Structure

**Workstream A — join path**

| File | Responsibility |
|---|---|
| `src/lib/auth/return-path.ts` (create) | `safeReturnPath` — the single validator for `return_to` / `next` values |
| `src/lib/auth/__tests__/return-path.test.ts` (create) | Its tests |
| `src/lib/supabase/middleware.ts` (modify) | Stop clearing `return_to`; honor it on the signed-in bounce |
| `src/app/api/organizations/invitations/route.ts` (modify) | Optional `next` on invite creation, appended to link + email |
| `src/app/invite/[token]/page.tsx` (modify) | Carry `?next=` through sign-in and land there after acceptance |
| `src/components/flows/jam-dialog.tsx` (modify) | Email-invite row; honest link copy; one-click share-link minting |
| `src/app/api/flows/[id]/route.ts` (modify) | `SHARE_LINK_INVALID` discriminator when a token was presented |
| `src/app/flows/[id]/page.tsx` (modify) | Distinguish join failures in the error state |
| `src/lib/notifications/__tests__/href.test.ts` (modify) | Pin `flow.jam_invite` → `/flows/<id>` |

**Workstream C — co-presence**

| File | Responsibility |
|---|---|
| `src/lib/flows/cursor-store.ts` (modify) | TTL-first pruning; presence-gate only when presence is known |
| `src/lib/flows/cursor-view.ts` (create) | `followableParticipants` — who is in which view, and what following does |
| `src/lib/flows/__tests__/cursor-view.test.ts` (create) | Its tests |
| `src/lib/flows/drag-preview.ts` (create) | Pure reducer for ephemeral remote drag positions |
| `src/lib/flows/__tests__/drag-preview.test.ts` (create) | Its tests |

**Workstream B — authorized realtime**

| File | Responsibility |
|---|---|
| `src/lib/flows/flow-channels.ts` (create) | Topic build/parse, subscribe-status machine, backoff |
| `src/lib/flows/__tests__/flow-channels.test.ts` (create) | Its tests |
| `src/lib/flows/use-flow-presence.ts` (create) | Presence payload, roster, deduped participants |
| `src/lib/flows/use-flow-cursors.ts` (create) | Cursor stream: throttle + trailing flush + prune |
| `src/lib/flows/use-flow-graph-sync.ts` (create) | `:ops` channel — diff/apply/bootstrap election |
| `src/lib/flows/use-flow-collab.ts` (modify) | Composition only; same public API |
| `src/lib/flows/__tests__/support/fake-realtime.ts` (create) | In-memory Supabase-channel double, shared by hook tests |
| `src/lib/flows/__tests__/collab-two-clients.test.tsx` (create) | Two simulated clients over the fake transport |
| `prisma/migrations/20260729120000_flow_jam_rls/migration.sql` (create) | `flow_topic_access` + `realtime.messages` policies |
| `supabase/flow-jam-rls.sql` (create) | Same SQL, hand-appliable fallback |
| `src/lib/flows/__tests__/flow-topic-access-parity.test.ts` (create) | Migration SQL and `resolveFlowRole` encode the same precedence |

---

# Workstream A — Invite & join

### Task 1: `safeReturnPath` + middleware stops discarding it

**Files:**
- Create: `src/lib/auth/return-path.ts`
- Create: `src/lib/auth/__tests__/return-path.test.ts`
- Modify: `src/lib/supabase/middleware.ts:54-74`

**Interfaces:**
- Produces: `safeReturnPath(raw: string | null | undefined): string | null` — returns the value only if it is a same-origin path (`/…`, not `//…`, no backslash, no control chars), else `null`. Used by Tasks 2, 3, 5 and by `auth-gateway.tsx` / `google-button.tsx`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/auth/__tests__/return-path.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeReturnPath } from '../return-path'

test('safeReturnPath keeps same-origin paths including their query string', () => {
  assert.equal(safeReturnPath('/flows/abc'), '/flows/abc')
  assert.equal(safeReturnPath('/flows/abc?share=tok'), '/flows/abc?share=tok')
  assert.equal(safeReturnPath('/invite/tok123'), '/invite/tok123')
})

test('safeReturnPath rejects anything that could leave the origin', () => {
  assert.equal(safeReturnPath('//evil.example.com'), null, 'protocol-relative')
  assert.equal(safeReturnPath('https://evil.example.com'), null, 'absolute URL')
  assert.equal(safeReturnPath('/\\evil.example.com'), null, 'backslash escape')
  assert.equal(safeReturnPath('flows/abc'), null, 'relative, no leading slash')
  assert.equal(safeReturnPath('/flows\nabc'), null, 'control character')
  assert.equal(safeReturnPath(null), null)
  assert.equal(safeReturnPath(undefined), null)
  assert.equal(safeReturnPath(''), null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A3 return-path`
Expected: FAIL — cannot find module `../return-path`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/auth/return-path.ts
/**
 * The single validator for post-auth destinations (`return_to`, `next`).
 * A destination is accepted only when it is unambiguously same-origin: one
 * leading slash, no scheme, no protocol-relative `//`, no backslash (which
 * some browsers normalize to `/`), and no control characters. Everything else
 * becomes null and the caller falls back to its own default.
 */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw) return null
  const value = raw.trim()
  if (!value.startsWith('/')) return null
  if (value.startsWith('//')) return null
  if (value.includes('\\')) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return null
  return value
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -A3 return-path`
Expected: PASS.

- [ ] **Step 5: Preserve `return_to` in the signup bounce**

In `src/lib/supabase/middleware.ts`, add `import { safeReturnPath } from '@/lib/auth/return-path'` and replace the signup block (currently lines 54-59):

```ts
  // Production is SSO/invite-only: password signup is disabled unless
  // explicitly allowed (AUTH_ALLOW_PASSWORD=true keeps it for dev). The
  // invitee's deep link MUST survive this bounce — clearing the search string
  // here is what silently dropped people into a fresh solo workspace instead
  // of the workspace (and flow) they were invited to.
  if (pathname === '/auth/signup' && process.env.AUTH_ALLOW_PASSWORD === 'false') {
    const carried = safeReturnPath(request.nextUrl.searchParams.get('return_to'))
    const url = request.nextUrl.clone()
    url.pathname = '/auth/login'
    url.search = ''
    if (carried) url.searchParams.set('return_to', carried)
    return copyCookies(response, NextResponse.redirect(url))
  }
```

- [ ] **Step 6: Honor `return_to` on the signed-in bounce**

Replace the signed-in-on-auth-page block (currently lines 69-74):

```ts
  // A signed-in user on an auth page goes where they were headed, not to a
  // blanket /dashboard — an invite or share link clicked in an already-signed-in
  // browser used to lose its destination here.
  if (user && isAuthPage && pathname !== '/auth/callback') {
    const carried = safeReturnPath(request.nextUrl.searchParams.get('return_to'))
    return copyCookies(response, NextResponse.redirect(new URL(carried ?? '/dashboard', request.url)))
  }
```

- [ ] **Step 7: Reuse the helper in the client auth surfaces**

In `src/components/auth/auth-gateway.tsx` and `src/components/auth/google-button.tsx`, replace each ad-hoc `return_to` regex check with `safeReturnPath(new URLSearchParams(window.location.search).get('return_to'))`. Keep each file's existing fallback destination.

- [ ] **Step 8: Run the gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add src/lib/auth src/lib/supabase/middleware.ts src/components/auth
git commit -m "fix(auth): stop discarding return_to on the signup and signed-in bounces"
```

---

### Task 2: Invitations carry a destination

**Files:**
- Modify: `src/app/api/organizations/invitations/route.ts`
- Modify: `src/app/invite/[token]/page.tsx`
- Modify: `src/lib/notifications/__tests__/href.test.ts`
- Test: `src/app/api/organizations/__tests__/invite-link.test.ts` (create)

**Interfaces:**
- Consumes: `safeReturnPath` (Task 1).
- Produces: `buildInviteLink(base: string, token: string, next?: string | null): string` exported from `src/app/api/organizations/invitations/route.ts`'s new sibling `src/lib/auth/invite-link.ts`, used by Task 3.

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/organizations/__tests__/invite-link.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildInviteLink } from '@/lib/auth/invite-link'

test('buildInviteLink points at the invite page and carries a safe next path', () => {
  assert.equal(buildInviteLink('https://app.test', 'tok'), 'https://app.test/invite/tok')
  assert.equal(
    buildInviteLink('https://app.test', 'tok', '/flows/f1'),
    'https://app.test/invite/tok?next=%2Fflows%2Ff1',
  )
})

test('buildInviteLink drops an unsafe next instead of forwarding it', () => {
  assert.equal(buildInviteLink('https://app.test', 'tok', '//evil.example.com'), 'https://app.test/invite/tok')
  assert.equal(buildInviteLink('https://app.test/', 'tok'), 'https://app.test/invite/tok', 'trailing slash normalized')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A3 invite-link`
Expected: FAIL — cannot find module `@/lib/auth/invite-link`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/auth/invite-link.ts
import { safeReturnPath } from './return-path'

/** The invitation acceptance URL. `next` (validated) is where acceptance lands
 *  the recipient — an invite sent from a jam points at that flow. */
export function buildInviteLink(base: string, token: string, next?: string | null): string {
  const origin = base.replace(/\/$/, '')
  const destination = safeReturnPath(next)
  const query = destination ? `?next=${encodeURIComponent(destination)}` : ''
  return `${origin}/invite/${token}${query}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -A3 invite-link`
Expected: PASS.

- [ ] **Step 5: Accept `next` when creating an invitation**

In `src/app/api/organizations/invitations/route.ts`: extend `createSchema` with `next: z.string().optional()`, import `buildInviteLink`, and replace the hand-built `const link = ...` with:

```ts
  const base = (process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin).replace(/\/$/, '')
  const link = buildInviteLink(base, token, next)
```

- [ ] **Step 6: Land acceptance on the invited destination**

In `src/app/invite/[token]/page.tsx`:

```tsx
  const searchParams = useSearchParams()
  // Where acceptance lands. An invite sent from a jam carries the flow; a plain
  // workspace invite has no `next` and falls back to the dashboard.
  const next = safeReturnPath(searchParams.get('next'))
  const returnTo = `/invite/${token}${next ? `?next=${encodeURIComponent(next)}` : ''}`
```

and in `accept()` replace the redirect with:

```tsx
      // Full reload so server auth context picks up the new workspace/role.
      window.location.href = next ?? '/dashboard?auth=success'
```

Add the imports: `useSearchParams` from `next/navigation` and `safeReturnPath` from `@/lib/auth/return-path`. Wrap the component body's `useSearchParams` usage per the app's existing Suspense convention if lint complains.

- [ ] **Step 7: Pin the jam-invite notification href**

Append to `src/lib/notifications/__tests__/href.test.ts`:

```ts
test('a jam invite deep-links to the flow, never the dashboard', () => {
  assert.equal(
    notificationHref({ type: 'flow.jam_invite', executionId: null, link: '/flows/f1' }),
    '/flows/f1',
  )
})
```

- [ ] **Step 8: Run the gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add src/lib/auth/invite-link.ts src/app/api/organizations src/app/invite src/lib/notifications
git commit -m "feat(invites): carry a destination through invitation acceptance"
```

---

### Task 3: Invite someone who isn't in the workspace yet, from the Jam dialog

**Files:**
- Modify: `src/components/flows/jam-dialog.tsx`
- Test: `src/components/flows/__tests__/jam-invite.test.tsx` (create)

**Interfaces:**
- Consumes: `buildInviteLink` semantics via `POST /api/organizations/invitations` (Task 2), `GET /api/organizations/members` (returns `members[{id,name,email,role}]` and `selfId`).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/flows/__tests__/jam-invite.test.tsx
import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen } from '@testing-library/react'
import { act } from 'react'
import { JamDialog } from '@/components/flows/jam-dialog'

const flush = async () => { await act(async () => { await Promise.resolve() }) }

test('an admin sees the email invite row; a non-admin is pointed at the share link', async () => {
  const calls: string[] = []
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url))
    return {
      ok: true,
      json: async () => ({ success: true, selfId: 'me', members: [{ id: 'me', name: 'Me', email: 'me@x.test', role: 'ADMIN' }] }),
    }
  }) as unknown as typeof fetch

  render(
    <JamDialog
      open
      onOpenChange={() => {}}
      flowId="f1"
      flowName="Flow"
      visibility="shared"
      canEdit
      onChangeVisibility={() => {}}
    />,
  )
  await flush()
  assert.ok(screen.getByPlaceholderText(/teammate@/i), 'admin gets the email field')
  cleanup()

  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ success: true, selfId: 'me', members: [{ id: 'me', name: 'Me', email: 'me@x.test', role: 'USER' }] }),
  })) as unknown as typeof fetch
  render(
    <JamDialog
      open
      onOpenChange={() => {}}
      flowId="f1"
      flowName="Flow"
      visibility="shared"
      canEdit
      onChangeVisibility={() => {}}
    />,
  )
  await flush()
  assert.equal(screen.queryByPlaceholderText(/teammate@/i), null, 'non-admin gets no workspace-invite field')
  assert.ok(screen.getByText(/only an admin can add people to your workspace/i))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A5 jam-invite`
Expected: FAIL — no email field rendered.

- [ ] **Step 3: Capture the caller's role when loading members**

In `jam-dialog.tsx`, widen `type Member` to `{ id: string; name: string | null; email: string | null; role?: string }`, add `const [isAdmin, setIsAdmin] = useState(false)`, and in the members effect set it before filtering self out:

```tsx
        const all = (data.members ?? []) as Member[]
        setIsAdmin(all.some((m) => m.id === data.selfId && m.role === 'ADMIN'))
        // You can't invite yourself — drop the caller from the list.
        setMembers(all.filter((m) => m.id !== data.selfId))
```

- [ ] **Step 4: Add the email-invite block**

Add state and handler:

```tsx
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviting, setInviting] = useState(false)
  const [workspaceLink, setWorkspaceLink] = useState<string | null>(null)

  // Invite a person who has no account yet: a workspace invitation whose
  // acceptance lands them on THIS flow. Admin-only — the API enforces it too.
  const inviteByEmail = async () => {
    const email = inviteEmail.trim()
    if (!email) return
    setInviting(true)
    try {
      const res = await fetch('/api/organizations/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, next: `/flows/${flowId}` }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error || 'Could not send that invitation.')
        return
      }
      setWorkspaceLink(data.link ?? null)
      setInviteEmail('')
      toast.success(data.emailSent
        ? `Invitation emailed to ${email} — it opens this flow once they join.`
        : `Invitation created for ${email} — copy the link below and send it to them.`)
    } finally {
      setInviting(false)
    }
  }
```

and render it inside the `canInvite` region, above the existing member list:

```tsx
          {canInvite && isAdmin && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Invite someone new</p>
              <div className="flex items-center gap-1.5">
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="teammate@company.com"
                  className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
                />
                <Button size="sm" onClick={() => void inviteByEmail()} loading={inviting} disabled={!inviteEmail.trim()}>
                  <UserPlus className="mr-1.5 h-4 w-4" /> Invite
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                They join your workspace and land straight on this flow.
              </p>
              {workspaceLink && (
                <p className="break-all rounded-lg border border-border/60 bg-muted/40 p-2 font-mono text-[11px]">{workspaceLink}</p>
              )}
            </div>
          )}
          {canInvite && !isAdmin && (
            <p className="rounded-lg border border-border/70 bg-muted/40 p-3 text-xs text-muted-foreground">
              Only an admin can add people to your workspace. To bring in someone else, turn on the
              share link below and send them that.
            </p>
          )}
```

Import `UserPlus` from `lucide-react`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test 2>&1 | grep -A5 jam-invite`
Expected: PASS.

- [ ] **Step 6: Run the gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/components/flows/jam-dialog.tsx src/components/flows/__tests__/jam-invite.test.tsx
git commit -m "feat(jam): invite people who aren't in the workspace yet"
```

---

### Task 4: The invite link tells the truth about who can open it

**Files:**
- Modify: `src/components/flows/jam-dialog.tsx`
- Test: `src/components/flows/__tests__/jam-invite.test.tsx` (extend)

**Interfaces:**
- Consumes: existing `updateShare(enabled, role, rotate)` in `jam-dialog.tsx` and the `shareToken` / `shareRole` / `onShareChanged` props.

- [ ] **Step 1: Write the failing test**

```tsx
test('without a share token the link row says so and offers one-click sharing', async () => {
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ success: true, selfId: 'me', members: [] }),
  })) as unknown as typeof fetch
  render(
    <JamDialog
      open
      onOpenChange={() => {}}
      flowId="f1"
      flowName="Flow"
      visibility="shared"
      canEdit
      onChangeVisibility={() => {}}
      shareToken={null}
    />,
  )
  await flush()
  assert.ok(screen.getByText(/only people in your workspace can open this/i))
  assert.ok(screen.getByRole('button', { name: /make this link work for anyone/i }))
})

test('with a share token the link row states the role it grants', async () => {
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ success: true, selfId: 'me', members: [] }),
  })) as unknown as typeof fetch
  render(
    <JamDialog
      open
      onOpenChange={() => {}}
      flowId="f1"
      flowName="Flow"
      visibility="shared"
      canEdit
      onChangeVisibility={() => {}}
      shareToken="tok"
      shareRole="edit"
    />,
  )
  await flush()
  assert.ok(screen.getByText(/anyone with this link can sign in and edit/i))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A5 jam-invite`
Expected: FAIL — copy not present.

- [ ] **Step 3: Replace the static link hint**

In `jam-dialog.tsx`, swap the paragraph under the invite-link row for:

```tsx
            {shareToken ? (
              <p className="text-xs text-muted-foreground">
                Anyone with this link can sign in and {shareRole === 'edit' ? 'edit' : 'view and run'} this flow.
              </p>
            ) : (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">
                  Right now only people in your workspace can open this link — anyone else gets “not found”.
                </p>
                {canEdit && shareable && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 rounded-full text-xs"
                    disabled={shareBusy}
                    onClick={() => void updateShare(true, 'edit')}
                  >
                    Make this link work for anyone I send it to
                  </Button>
                )}
              </div>
            )}
```

Move the `shareBusy` / `updateShare` declarations above the returned JSX if they are declared after it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -A5 jam-invite`
Expected: PASS.

- [ ] **Step 5: Run the gate and commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/components/flows/jam-dialog.tsx src/components/flows/__tests__/jam-invite.test.tsx
git commit -m "feat(jam): honest invite link with one-click sharing"
```

---

### Task 5: Real errors when a join fails

**Files:**
- Modify: `src/app/api/flows/[id]/route.ts`
- Modify: `src/app/flows/[id]/page.tsx` (load effect ~line 328-362 and the `loadError` render)
- Test: `src/lib/flows/__tests__/join-error.test.ts` (create)

**Interfaces:**
- Produces: `joinErrorMessage(code: string | null, signedInAs: string | null): { title: string; body: string; canSwitchAccount: boolean }` in `src/lib/flows/join-error.ts`, consumed by the builder's error state.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/flows/__tests__/join-error.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joinErrorMessage } from '../join-error'

test('an invalid share link is named as such and offers an account switch', () => {
  const m = joinErrorMessage('SHARE_LINK_INVALID', 'sam@work.test')
  assert.match(m.title, /link/i)
  assert.match(m.body, /sam@work\.test/)
  assert.equal(m.canSwitchAccount, true)
})

test('a plain no-access failure never claims the flow exists', () => {
  const m = joinErrorMessage('NOT_FOUND', 'sam@work.test')
  assert.match(m.title, /couldn’t open/i)
  assert.equal(m.canSwitchAccount, true)
})

test('an unknown/transient failure reads as transient and offers no account switch', () => {
  const m = joinErrorMessage(null, null)
  assert.match(m.body, /try again/i)
  assert.equal(m.canSwitchAccount, false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A5 join-error`
Expected: FAIL — cannot find module `../join-error`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/flows/join-error.ts
/**
 * What to show when opening a flow failed. The API returns
 * SHARE_LINK_INVALID only when the caller PRESENTED a share token — for
 * everyone else a missing and an inaccessible flow are indistinguishable, and
 * this copy keeps them that way.
 */
export function joinErrorMessage(
  code: string | null,
  signedInAs: string | null,
): { title: string; body: string; canSwitchAccount: boolean } {
  if (code === 'SHARE_LINK_INVALID') {
    return {
      title: 'This share link is no longer valid',
      body: signedInAs
        ? `The link was turned off or rotated. Ask whoever shared it for a new one — you’re signed in as ${signedInAs}.`
        : 'The link was turned off or rotated. Ask whoever shared it for a new one.',
      canSwitchAccount: Boolean(signedInAs),
    }
  }
  if (code === 'NOT_FOUND') {
    return {
      title: 'We couldn’t open this flow',
      body: signedInAs
        ? `It may have been deleted, or this account doesn’t have access — you’re signed in as ${signedInAs}.`
        : 'It may have been deleted, or this account doesn’t have access.',
      canSwitchAccount: Boolean(signedInAs),
    }
  }
  return {
    title: 'We couldn’t open this flow',
    body: 'Something went wrong loading it. Check your connection and try again.',
    canSwitchAccount: false,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -A5 join-error`
Expected: PASS.

- [ ] **Step 5: Return the discriminator from the API**

In `src/app/api/flows/[id]/route.ts`, after `const role = resolveFlowRole(...)`:

```ts
  if (!role) {
    // A caller who PRESENTED a token that doesn't match gets told the link is
    // dead — they already hold a token, so this leaks nothing new, and it is
    // the only way rotation is comprehensible. Everyone else gets a plain 404.
    if (token && token !== flow.shareToken) {
      throw new ApiError('This share link is no longer valid.', 404, 'SHARE_LINK_INVALID')
    }
    throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  }
```

- [ ] **Step 6: Carry the code into the builder's error state**

In `src/app/flows/[id]/page.tsx`, change `const [loadError, setLoadError] = useState(false)` to `useState<string | null>(null)` (null = no error; a string = the code, `'UNKNOWN'` for transient). In the load effect:

```ts
          const res = await fetch(`/api/flows/${id}${shareParam ? `?share=${encodeURIComponent(shareParam)}` : ''}`, { cache: 'no-store' }).catch(() => null)
          const data = res ? await res.json().catch(() => null) : null
          if (data?.flow) flow = data.flow
          else if (!cancelled && res && !res.ok) setLoadError(typeof data?.code === 'string' ? data.code : 'NOT_FOUND')
```

and set `setLoadError('UNKNOWN')` in the `.catch`, `setLoadError('NOT_FOUND')` in the existing else branch. Render the error state through `joinErrorMessage(loadError, user?.email ?? null)`, adding a "Sign in with a different account" button (visible when `canSwitchAccount`) that calls `signOut()` then navigates to `/auth/login?return_to=<current path + search>`.

- [ ] **Step 7: Run the gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/lib/flows/join-error.ts src/lib/flows/__tests__/join-error.test.ts src/app/api/flows src/app/flows
git commit -m "feat(flows): tell people why a jam link didn't open"
```

---

# Workstream C — Seeing each other work

### Task 6: Cursors survive presence hiccups and rest where they stopped

**Files:**
- Modify: `src/lib/flows/cursor-store.ts`
- Modify: `src/lib/flows/__tests__/cursor-store.test.ts` (create if absent)
- Modify: `src/lib/flows/use-flow-collab.ts` (cursor throttle)

**Interfaces:**
- Produces: `pruneCursors(list, now, presentClientIds: Set<string> | null, ttlMs?)` — **`null` means presence is unknown**, in which case only the TTL applies. Consumed by Task 11's `use-flow-cursors.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/flows/__tests__/cursor-store.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pruneCursors, upsertCursor, type RemoteCursor } from '../cursor-store'

const cursor = (clientId: string, ts: number): RemoteCursor =>
  ({ clientId, x: 1, y: 2, name: 'Sam', color: '#000', space: 'canvas', ts })

test('an unknown presence set prunes on TTL only — a presence hiccup must not erase live cursors', () => {
  const list = [cursor('a', 1_000)]
  assert.deepEqual(pruneCursors(list, 2_000, null), list)
  assert.deepEqual(pruneCursors(list, 9_000, null), [], 'still expires on TTL')
})

test('an empty presence set is treated as unknown, not as "everyone left"', () => {
  const list = [cursor('a', 1_000)]
  assert.deepEqual(pruneCursors(list, 2_000, new Set()), list)
})

test('a known, non-empty presence set drops departed clients', () => {
  const list = [cursor('a', 1_000), cursor('b', 1_000)]
  assert.deepEqual(pruneCursors(list, 2_000, new Set(['a'])), [cursor('a', 1_000)])
})

test('upsertCursor replaces by clientId and appends newcomers', () => {
  const first = upsertCursor([], cursor('a', 1))
  assert.equal(first.length, 1)
  const moved = upsertCursor(first, { ...cursor('a', 2), x: 99 })
  assert.equal(moved.length, 1)
  assert.equal(moved[0].x, 99)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A5 cursor-store`
Expected: FAIL — an empty/`null` presence set currently drops everything.

- [ ] **Step 3: Write the implementation**

Replace `pruneCursors` in `src/lib/flows/cursor-store.ts`:

```ts
/**
 * Drop cursors idle past the TTL, and — only when presence is actually known —
 * those whose client has left the room. An empty or absent presence set means
 * "we don't know yet", NOT "everyone left": gating on it unconditionally meant
 * a single presence hiccup erased every cursor on screen while packets kept
 * arriving.
 */
export function pruneCursors(
  list: RemoteCursor[],
  now: number,
  presentClientIds: Set<string> | null,
  ttlMs = 5_000,
): RemoteCursor[] {
  const gate = presentClientIds && presentClientIds.size > 0 ? presentClientIds : null
  const kept = list.filter((c) => now - c.ts <= ttlMs && (!gate || gate.has(c.clientId)))
  return kept.length === list.length ? list : kept
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -A5 cursor-store`
Expected: PASS.

- [ ] **Step 5: Add the trailing flush**

In `use-flow-collab.ts`'s `sendCursor`, keep the leading-edge send but schedule a trailing send of the last suppressed position so a cursor that stops moving rests where the pointer actually is:

```ts
  const lastCursorAt = useRef(0)
  const pendingCursor = useRef<{ x: number; y: number; space: CursorSpace } | null>(null)
  const cursorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const emitCursor = useCallback((x: number, y: number, space: CursorSpace) => {
    const me = presenceRef.current
    if (!me) return
    lastCursorAt.current = Date.now()
    channelRef.current?.send({
      type: 'broadcast',
      event: 'cursor',
      payload: { clientId, x, y, name: me.name, color: me.color, space },
    })
  }, [clientId])
  const sendCursor = useCallback((x: number, y: number, space: CursorSpace = 'inline') => {
    const elapsed = Date.now() - lastCursorAt.current
    if (elapsed >= CURSOR_INTERVAL_MS) { emitCursor(x, y, space); return }
    // Throttled: remember the newest position and flush it at the interval, so
    // a pointer that stops mid-throttle doesn't leave a stale cursor behind.
    pendingCursor.current = { x, y, space }
    if (cursorTimer.current) return
    cursorTimer.current = setTimeout(() => {
      cursorTimer.current = null
      const next = pendingCursor.current
      pendingCursor.current = null
      if (next) emitCursor(next.x, next.y, next.space)
    }, CURSOR_INTERVAL_MS - elapsed)
  }, [emitCursor])
  useEffect(() => () => { if (cursorTimer.current) clearTimeout(cursorTimer.current) }, [])
```

Update the two `pruneCursors(prev, Date.now(), presentIdsRef.current)` call sites to pass `presentIdsRef.current` unchanged (the new signature accepts it) — no behavioral change needed there.

- [ ] **Step 6: Run the gate and commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/lib/flows/cursor-store.ts src/lib/flows/__tests__/cursor-store.test.ts src/lib/flows/use-flow-collab.ts
git commit -m "fix(jam): keep cursors alive through presence hiccups and flush the last position"
```

---

### Task 7: See teammates in the other view, and follow them

**Files:**
- Create: `src/lib/flows/cursor-view.ts`
- Create: `src/lib/flows/__tests__/cursor-view.test.ts`
- Modify: `src/lib/flows/use-flow-collab.ts` (presence gains `view`, plus `setView`)
- Modify: `src/app/flows/[id]/page.tsx` (publish view; wire follow)
- Modify: `src/components/flows/jam-dialog.tsx` (roster shows view + follow button)

**Interfaces:**
- Consumes: `CollabParticipant` from `use-flow-collab.ts`, widened with `view?: 'inline' | 'canvas'`.
- Produces: `describeParticipantView(p, myView)` → `{ label: string; needsFollow: boolean }` and `setView(view: BuilderView)` on the collab hook's return value. Consumed by Task 11's presence hook.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/flows/__tests__/cursor-view.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeParticipantView } from '../cursor-view'

test('a teammate in the other view is labelled and marked as needing a follow', () => {
  const r = describeParticipantView({ view: 'canvas' }, 'inline')
  assert.equal(r.label, 'Canvas view')
  assert.equal(r.needsFollow, true)
})

test('a teammate in my view needs no follow and carries no label', () => {
  const r = describeParticipantView({ view: 'inline' }, 'inline')
  assert.equal(r.label, '')
  assert.equal(r.needsFollow, false)
})

test('a participant from a client that predates view-in-presence is assumed to be with me', () => {
  const r = describeParticipantView({}, 'canvas')
  assert.equal(r.needsFollow, false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A5 cursor-view`
Expected: FAIL — cannot find module `../cursor-view`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/flows/cursor-view.ts
import type { CursorSpace } from './cursor-store'

/**
 * Inline lays steps out in document pixels and Canvas in DAG coordinates, so a
 * cursor is only drawable for viewers on the same view. Rather than silently
 * hiding a teammate (which read as "cursors are broken"), presence carries the
 * view and the roster says where they are, with one click to join them.
 * Packets from clients that predate this field are assumed to be co-located.
 */
export function describeParticipantView(
  participant: { view?: CursorSpace },
  myView: CursorSpace,
): { label: string; needsFollow: boolean } {
  const view = participant.view
  if (!view || view === myView) return { label: '', needsFollow: false }
  return { label: view === 'canvas' ? 'Canvas view' : 'Inline view', needsFollow: true }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -A5 cursor-view`
Expected: PASS.

- [ ] **Step 5: Publish the view in presence**

In `use-flow-collab.ts`: add `view?: CursorSpace` to `CollabParticipant`, include `view: presenceRef.current?.view ?? 'inline'` when building the presence payload, and export a `setView` mirroring `setSelection`:

```ts
  const setView = useCallback((view: CursorSpace) => {
    if (!presenceRef.current || presenceRef.current.view === view) return
    presenceRef.current = { ...presenceRef.current, view }
    retrack()
  }, [retrack])
```

Add `setView` to the returned object and its type.

- [ ] **Step 6: Wire the page**

In `src/app/flows/[id]/page.tsx`: `useEffect(() => { setView(view) }, [view, setView])`, and pass richer presence to the dialog:

```tsx
        presence={others.map((p) => ({
          id: p.clientId,
          name: p.name,
          color: p.color,
          inHuddle: p.inHuddle,
          ...describeParticipantView(p, view),
        }))}
        onFollow={(target) => { if (target === 'canvas' || target === 'inline') changeView(target) }}
        myView={view}
```

- [ ] **Step 7: Show it in the Jam dialog**

Widen the `presence` prop type with `label?: string; needsFollow?: boolean; view?: 'inline' | 'canvas'`, add `onFollow?: (view: 'inline' | 'canvas') => void` and `myView?: 'inline' | 'canvas'`, and inside each presence chip render, when `needsFollow`:

```tsx
                    <button
                      type="button"
                      onClick={() => onFollow?.(p.view === 'canvas' ? 'canvas' : 'inline')}
                      className="rounded-full border border-border/70 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent"
                    >
                      {p.label} — follow
                    </button>
```

- [ ] **Step 8: Run the gate and commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/lib/flows/cursor-view.ts src/lib/flows/__tests__/cursor-view.test.ts src/lib/flows/use-flow-collab.ts src/app/flows src/components/flows/jam-dialog.tsx
git commit -m "feat(jam): show which view a teammate is in and follow them there"
```

---

### Task 8: Node drags move, instead of teleporting

**Files:**
- Create: `src/lib/flows/drag-preview.ts`
- Create: `src/lib/flows/__tests__/drag-preview.test.ts`
- Modify: `src/lib/flows/use-flow-collab.ts` (`BusEvent` gains `'drag'`)
- Modify: `src/components/flows/canvas/graph-canvas.tsx` (emit during drag, apply remote drags)
- Modify: `src/app/flows/[id]/page.tsx` (bridge bus ↔ canvas)

**Interfaces:**
- Consumes: `bus` from `useFlowCollab` (`send`/`on`), `BusEvent` widened to `'saved' | 'huddle' | 'drag'`.
- Produces: `applyDragPreview(state, event, now)` and `pruneDragPreview(state, now, ttlMs?)` over `DragPreview = Record<string, { x: number; y: number; ts: number }>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/flows/__tests__/drag-preview.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyDragPreview, pruneDragPreview } from '../drag-preview'

test('a drag event records the node position and the newest wins', () => {
  const a = applyDragPreview({}, { nodeId: 'n1', x: 10, y: 20 }, 1_000)
  assert.deepEqual(a.n1, { x: 10, y: 20, ts: 1_000 })
  const b = applyDragPreview(a, { nodeId: 'n1', x: 30, y: 40 }, 1_100)
  assert.deepEqual(b.n1, { x: 30, y: 40, ts: 1_100 })
})

test('a drag END clears the node so the committed graph position takes over', () => {
  const a = applyDragPreview({}, { nodeId: 'n1', x: 10, y: 20 }, 1_000)
  const done = applyDragPreview(a, { nodeId: 'n1', done: true }, 1_200)
  assert.equal(done.n1, undefined)
})

test('a preview whose sender vanished mid-drag expires instead of pinning the node', () => {
  const a = applyDragPreview({}, { nodeId: 'n1', x: 1, y: 1 }, 1_000)
  assert.deepEqual(pruneDragPreview(a, 1_500), a)
  assert.deepEqual(pruneDragPreview(a, 5_000), {})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A5 drag-preview`
Expected: FAIL — cannot find module `../drag-preview`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/flows/drag-preview.ts
export type DragPreview = Record<string, { x: number; y: number; ts: number }>
export type DragEvent = { nodeId: string; x?: number; y?: number; done?: boolean }

/**
 * Ephemeral positions for nodes a TEAMMATE is currently dragging. These never
 * enter the graph or the undo history — the real op broadcast on release is
 * what commits — so a dropped `done` event can only leave a stale ghost for
 * the TTL, never a corrupted graph.
 */
export function applyDragPreview(state: DragPreview, event: DragEvent, now: number): DragPreview {
  const next = { ...state }
  if (event.done || typeof event.x !== 'number' || typeof event.y !== 'number') {
    delete next[event.nodeId]
    return next
  }
  next[event.nodeId] = { x: event.x, y: event.y, ts: now }
  return next
}

/** Expire previews from a client that vanished mid-drag. */
export function pruneDragPreview(state: DragPreview, now: number, ttlMs = 3_000): DragPreview {
  const entries = Object.entries(state).filter(([, v]) => now - v.ts <= ttlMs)
  return entries.length === Object.keys(state).length ? state : Object.fromEntries(entries)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -A5 drag-preview`
Expected: PASS.

- [ ] **Step 5: Widen the bus whitelist**

In `use-flow-collab.ts`: `export type BusEvent = 'saved' | 'huddle' | 'drag'` and `const BUS_EVENTS: BusEvent[] = ['saved', 'huddle', 'drag']`.

- [ ] **Step 6: Emit while dragging**

In `graph-canvas.tsx`, add an optional `onNodeDrag?: (nodeId: string, position: NodePosition, done: boolean) => void` prop and wire React Flow's `onNodeDrag` / `onNodeDragStop`:

```tsx
          onNodeDrag={(_, node) => onNodeDrag?.(node.id, { x: Math.round(node.position.x), y: Math.round(node.position.y) }, false)}
```

and inside the existing `handleNodeDragStop`, after `onMoveNodes(moved)`, call `for (const id of moved.keys()) onNodeDrag?.(id, moved.get(id)!, true)`.

- [ ] **Step 7: Apply remote drags**

Add a `dragPreview?: DragPreview` prop to `GraphCanvasProps`, and in the effect that rebuilds `rfNodes`, override the position of any node present in `dragPreview` (preview wins while it exists). Do **not** feed preview positions into `onMoveNodes`.

- [ ] **Step 8: Bridge in the page**

```tsx
  const [dragPreview, setDragPreview] = useState<DragPreview>({})
  useEffect(() => bus.on('drag', (payload) => {
    const nodeId = typeof payload.nodeId === 'string' ? payload.nodeId : null
    if (!nodeId) return
    setDragPreview((prev) => applyDragPreview(prev, {
      nodeId,
      x: typeof payload.x === 'number' ? payload.x : undefined,
      y: typeof payload.y === 'number' ? payload.y : undefined,
      done: payload.done === true,
    }, Date.now()))
  }), [bus])
  useEffect(() => {
    const timer = window.setInterval(() => setDragPreview((prev) => pruneDragPreview(prev, Date.now())), 1_000)
    return () => window.clearInterval(timer)
  }, [])
```

and pass `dragPreview={dragPreview}` plus `onNodeDrag={(nodeId, position, done) => { if (canEdit) bus.send('drag', { nodeId, ...position, done }) }}` to `<GraphCanvas>`.

- [ ] **Step 9: Run the gate and commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/lib/flows/drag-preview.ts src/lib/flows/__tests__/drag-preview.test.ts src/lib/flows src/components/flows/canvas/graph-canvas.tsx src/app/flows
git commit -m "feat(jam): stream node drags so teammates see movement, not teleports"
```

---

# Workstream B — Server-authorized realtime

### Task 9: Topics and the connection-status machine

**Files:**
- Create: `src/lib/flows/flow-channels.ts`
- Create: `src/lib/flows/__tests__/flow-channels.test.ts`

**Interfaces:**
- Produces:
  - `flowTopic(flowId: string): string` → `flow:<id>`
  - `flowOpsTopic(flowId: string): string` → `flow:<id>:ops`
  - `parseFlowTopic(topic: string): { flowId: string; kind: 'room' | 'ops' } | null`
  - `type JamStatus = 'connecting' | 'live' | 'degraded' | 'error'`
  - `nextJamStatus(current: JamStatus, subscribeStatus: string): JamStatus`
  - `retryDelayMs(attempt: number): number` — capped exponential backoff.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/flows/__tests__/flow-channels.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowTopic, flowOpsTopic, parseFlowTopic, nextJamStatus, retryDelayMs } from '../flow-channels'

test('topics round-trip and reject anything unrecognized', () => {
  assert.equal(flowTopic('f1'), 'flow:f1')
  assert.equal(flowOpsTopic('f1'), 'flow:f1:ops')
  assert.deepEqual(parseFlowTopic('flow:f1'), { flowId: 'f1', kind: 'room' })
  assert.deepEqual(parseFlowTopic('flow:f1:ops'), { flowId: 'f1', kind: 'ops' })
  assert.equal(parseFlowTopic('flow:'), null)
  assert.equal(parseFlowTopic('flow:f1:other'), null)
  assert.equal(parseFlowTopic('agent:f1'), null)
})

test('subscribe outcomes map onto a status a human can act on', () => {
  assert.equal(nextJamStatus('connecting', 'SUBSCRIBED'), 'live')
  assert.equal(nextJamStatus('live', 'CHANNEL_ERROR'), 'error')
  assert.equal(nextJamStatus('live', 'TIMED_OUT'), 'degraded')
  assert.equal(nextJamStatus('live', 'CLOSED'), 'degraded')
  assert.equal(nextJamStatus('error', 'SUBSCRIBED'), 'live', 'recovery clears the error')
})

test('backoff grows and is capped so a dead channel cannot hot-loop', () => {
  assert.equal(retryDelayMs(0), 1_000)
  assert.equal(retryDelayMs(1), 2_000)
  assert.equal(retryDelayMs(3), 8_000)
  assert.equal(retryDelayMs(10), 30_000)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A5 flow-channels`
Expected: FAIL — cannot find module `../flow-channels`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/flows/flow-channels.ts
/**
 * A flow jam rides TWO private Supabase Realtime topics:
 *   flow:<id>      — presence, cursors, huddle signaling, the `saved` bus.
 *                    Writable by anyone with ANY access to the flow.
 *   flow:<id>:ops  — graph change-sets. RLS on realtime.messages allows
 *                    INSERT only for editors, so a view-only participant
 *                    physically cannot inject graph edits.
 * Both are private channels: joining requires Postgres to confirm the caller
 * can access the flow (see the flow_topic_access migration).
 */
export function flowTopic(flowId: string): string { return `flow:${flowId}` }
export function flowOpsTopic(flowId: string): string { return `flow:${flowId}:ops` }

export function parseFlowTopic(topic: string): { flowId: string; kind: 'room' | 'ops' } | null {
  const parts = topic.split(':')
  if (parts[0] !== 'flow' || !parts[1]) return null
  if (parts.length === 2) return { flowId: parts[1], kind: 'room' }
  if (parts.length === 3 && parts[2] === 'ops') return { flowId: parts[1], kind: 'ops' }
  return null
}

/** What the jam indicator shows. `degraded` means we expect to recover on our
 *  own (retrying); `error` means the join was refused and needs attention. */
export type JamStatus = 'connecting' | 'live' | 'degraded' | 'error'

export function nextJamStatus(current: JamStatus, subscribeStatus: string): JamStatus {
  switch (subscribeStatus) {
    case 'SUBSCRIBED': return 'live'
    case 'CHANNEL_ERROR': return 'error'
    case 'TIMED_OUT':
    case 'CLOSED': return 'degraded'
    default: return current
  }
}

const RETRY_BASE_MS = 1_000
const RETRY_CAP_MS = 30_000
/** Capped exponential backoff so a permanently-refused channel retries slowly
 *  instead of hammering the socket. */
export function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -A5 flow-channels`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/flow-channels.ts src/lib/flows/__tests__/flow-channels.test.ts
git commit -m "feat(jam): topic helpers and a connection-status machine"
```

---

### Task 10: Split the collab hook, with a fake transport to prove it

**Files:**
- Create: `src/lib/flows/__tests__/support/fake-realtime.ts`
- Create: `src/lib/flows/use-flow-presence.ts`
- Create: `src/lib/flows/use-flow-cursors.ts`
- Create: `src/lib/flows/use-flow-graph-sync.ts`
- Modify: `src/lib/flows/use-flow-collab.ts` (composition only)
- Create: `src/lib/flows/__tests__/collab-two-clients.test.tsx`

**Interfaces:**
- Consumes: `flowTopic`, `flowOpsTopic`, `nextJamStatus`, `retryDelayMs` (Task 9); `pruneCursors`, `upsertCursor` (Task 6); `diffGraph`, `applyGraphOps`, `isEmptyOps` from `graph-ops.ts`; `electPersister`, `shouldAnswerBootstrap` from `collab-roles.ts`.
- Produces: `useFlowCollab(flowId, self, onRemoteGraph, getLocalGraph, options?: { client?: SupabaseLike })` — return shape **unchanged** except two additions: `status: JamStatus` and `setView`. `SupabaseLike` is the minimal surface the hook uses (`channel`, `removeChannel`, `realtime.setAuth`), exported from `flow-channels.ts` so tests can substitute a double.

- [ ] **Step 1: Write the fake transport**

```ts
// src/lib/flows/__tests__/support/fake-realtime.ts
type Handler = (payload: { payload?: Record<string, unknown>; key?: string; event?: string }) => void

/** An in-memory stand-in for Supabase Realtime: channels with the same topic
 *  share a room, broadcasts reach every OTHER member, and presence is a map of
 *  tracked payloads. Enough surface for the collab hooks, and synchronous so
 *  tests need no timers. */
export class FakeRealtime {
  rooms = new Map<string, Set<FakeChannel>>()
  /** Topics whose INSERT is refused — models the ops-topic RLS wall. */
  denyWrite = new Set<string>()
  channel(topic: string) { return new FakeChannel(this, topic) }
  removeChannel(channel: FakeChannel) { this.rooms.get(channel.topic)?.delete(channel) }
  realtime = { setAuth: async () => {} }
}

export class FakeChannel {
  handlers: { type: string; event: string; handler: Handler }[] = []
  presence: Record<string, Record<string, unknown>[]> = {}
  state: 'closed' | 'joined' = 'closed'
  constructor(readonly hub: FakeRealtime, readonly topic: string) {}
  on(type: string, filter: { event: string }, handler: Handler) {
    this.handlers.push({ type, event: filter.event, handler })
    return this
  }
  subscribe(cb?: (status: string) => void) {
    const room = this.hub.rooms.get(this.topic) ?? new Set<FakeChannel>()
    room.add(this)
    this.hub.rooms.set(this.topic, room)
    this.state = 'joined'
    cb?.('SUBSCRIBED')
    return this
  }
  send(message: { type: string; event: string; payload: Record<string, unknown> }) {
    if (this.hub.denyWrite.has(this.topic)) return Promise.resolve('error')
    for (const peer of this.hub.rooms.get(this.topic) ?? []) {
      if (peer === this) continue
      for (const h of peer.handlers) {
        if (h.type === message.type && h.event === message.event) h.handler({ payload: message.payload })
      }
    }
    return Promise.resolve('ok')
  }
  async track(payload: Record<string, unknown>) {
    this.presence[String(payload.clientId)] = [payload]
    for (const peer of this.hub.rooms.get(this.topic) ?? []) {
      peer.presence[String(payload.clientId)] = [payload]
      for (const h of peer.handlers) {
        if (h.type === 'presence' && h.event === 'sync') h.handler({})
        if (h.type === 'presence' && h.event === 'join' && peer !== this) h.handler({ key: String(payload.clientId) })
      }
    }
  }
  async untrack() {}
  presenceState<T>() { return this.presence as unknown as Record<string, T[]> }
}
```

- [ ] **Step 2: Write the failing two-client test**

```tsx
// src/lib/flows/__tests__/collab-two-clients.test.tsx
import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, act, cleanup } from '@testing-library/react'
import { useFlowCollab } from '../use-flow-collab'
import { FakeRealtime } from './support/fake-realtime'
import { flowOpsTopic } from '../flow-channels'
import type { FlowGraph } from '../graph'

const graph = (ids: string[]): FlowGraph => ({
  nodes: ids.map((id) => ({ id, type: 'code', position: { x: 0, y: 0 }, data: { label: id } })) as FlowGraph['nodes'],
  edges: [],
})

function Peer({ hub, name, canEdit, seed, sink }: {
  hub: FakeRealtime; name: string; canEdit: boolean; seed: FlowGraph
  sink: { graph: FlowGraph; api?: ReturnType<typeof useFlowCollab> }
}) {
  const api = useFlowCollab(
    'f1',
    { userId: name, name, canEdit },
    (next) => { sink.graph = next },
    () => sink.graph,
    { client: hub as never },
  )
  sink.api = api
  React.useEffect(() => { sink.graph = seed }, [seed, sink])
  return null
}

test('an edit by one peer reaches the other', async () => {
  const hub = new FakeRealtime()
  const a = { graph: graph(['n1']) }
  const b = { graph: graph(['n1']) }
  render(<><Peer hub={hub} name="a" canEdit seed={a.graph} sink={a} /><Peer hub={hub} name="b" canEdit seed={b.graph} sink={b} /></>)
  await act(async () => { await Promise.resolve() })
  a.graph = graph(['n1', 'n2'])
  await act(async () => { a.api!.broadcastGraph(a.graph); await Promise.resolve() })
  assert.deepEqual(b.graph.nodes.map((n) => n.id).sort(), ['n1', 'n2'])
  cleanup()
})

test('a view-only peer cannot push graph ops (the ops topic refuses the write)', async () => {
  const hub = new FakeRealtime()
  hub.denyWrite.add(flowOpsTopic('f1'))
  const a = { graph: graph(['n1']) }
  const b = { graph: graph(['n1']) }
  render(<><Peer hub={hub} name="a" canEdit={false} seed={a.graph} sink={a} /><Peer hub={hub} name="b" canEdit seed={b.graph} sink={b} /></>)
  await act(async () => { await Promise.resolve() })
  a.graph = graph(['n1', 'evil'])
  await act(async () => { a.api!.broadcastGraph(a.graph); await Promise.resolve() })
  assert.deepEqual(b.graph.nodes.map((n) => n.id), ['n1'])
  cleanup()
})

test('cursors from a peer arrive and carry their view', async () => {
  const hub = new FakeRealtime()
  const a = { graph: graph(['n1']) }
  const b = { graph: graph(['n1']) }
  render(<><Peer hub={hub} name="a" canEdit seed={a.graph} sink={a} /><Peer hub={hub} name="b" canEdit seed={b.graph} sink={b} /></>)
  await act(async () => { await Promise.resolve() })
  await act(async () => { a.api!.sendCursor(12, 34, 'canvas'); await Promise.resolve() })
  const seen = b.api!.cursors
  assert.equal(seen.length, 1)
  assert.equal(seen[0].x, 12)
  assert.equal(seen[0].space, 'canvas')
  cleanup()
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A5 collab-two-clients`
Expected: FAIL — `useFlowCollab` takes no `options.client`, and graph ops still ride the single channel.

- [ ] **Step 4: Extract the presence hook**

Create `src/lib/flows/use-flow-presence.ts` by moving, verbatim where possible, the presence half of `use-flow-collab.ts`: `presenceColor`, `dedupeParticipants`, the `CollabParticipant` type, `presenceRef`, `retrack`, `setSelection`, `setInHuddle`, `setView`, and the `presence` bindings. It owns the `flow:<id>` channel and exposes:

```ts
export function useFlowPresence(flowId: string, self: {...} | null, clientId: string, client: SupabaseLike): {
  participants: CollabParticipant[]
  roster: CollabParticipant[]
  presentIds: React.MutableRefObject<Set<string>>
  channel: React.MutableRefObject<FlowChannel | null>
  status: JamStatus
  setSelection: (nodeId: string | null) => void
  setInHuddle: (inHuddle: boolean) => void
  setView: (view: CursorSpace) => void
  bus: CollabBus
}
```

Keep every existing comment that explains a non-obvious decision.

- [ ] **Step 5: Extract the cursor hook**

Create `src/lib/flows/use-flow-cursors.ts` owning the `cursor` broadcast binding, the throttle + trailing flush from Task 6, and the prune interval. It receives the room channel ref and `presentIds` from the presence hook and exposes `{ cursors, sendCursor }`.

- [ ] **Step 6: Extract the graph-sync hook onto the ops topic**

Create `src/lib/flows/use-flow-graph-sync.ts` owning the **`flow:<id>:ops`** channel: the `graph` broadcast binding, `lastGraphRef`, the diff/flush throttle, and the join-bootstrap election. Bootstrap answering keys off the *ops* channel's presence state (an editor answers; `shouldAnswerBootstrap` is unchanged). Exposes `{ broadcastGraph, status }`.

- [ ] **Step 7: Recompose `use-flow-collab.ts`**

`use-flow-collab.ts` becomes composition: generate `clientId`, resolve the client (`options?.client ?? createClient()`), call the three hooks, merge the two statuses (worst-of: `error` > `degraded` > `connecting` > `live`), and return the same object as before plus `status` and `setView`. Re-export `RemoteCursor`, `CursorSpace`, `CollabParticipant`, `BusEvent`, `CollabBus`, and `presenceColor` so existing imports keep working.

- [ ] **Step 8: Run test to verify it passes**

Run: `npm test 2>&1 | grep -A5 collab-two-clients`
Expected: PASS (all three).

- [ ] **Step 9: Run the gate and commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/lib/flows
git commit -m "refactor(jam): split the collab hook and move graph ops onto their own topic"
```

---

### Task 11: Private channels, fail closed, and a status people can see

**Files:**
- Modify: `src/lib/flows/use-flow-presence.ts`, `use-flow-graph-sync.ts` (private + `setAuth` + retry)
- Modify: `src/app/flows/[id]/page.tsx` (status pill + degraded banner)
- Test: `src/lib/flows/__tests__/flow-channels.test.ts` (extend)

**Interfaces:**
- Consumes: `nextJamStatus`, `retryDelayMs` (Task 9); `status` from Task 10.

- [ ] **Step 1: Write the failing test**

```ts
test('a refused join settles on error and keeps the backoff bounded', () => {
  let status = nextJamStatus('connecting', 'CHANNEL_ERROR')
  assert.equal(status, 'error')
  status = nextJamStatus(status, 'CHANNEL_ERROR')
  assert.equal(status, 'error', 'repeated refusals stay error, never flap to live')
  assert.ok(retryDelayMs(6) <= 30_000)
})
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `npm test 2>&1 | grep -A5 flow-channels`
Expected: PASS if Task 9 is correct — this pins the behavior Task 11 depends on. If it fails, fix `nextJamStatus` before continuing.

- [ ] **Step 3: Make both channels private and authenticated**

In each channel-owning hook, before `subscribe()`:

```ts
      // Private channels are authorized by Postgres (RLS on realtime.messages
      // via flow_topic_access), so the socket MUST carry the user's JWT — an
      // unauthenticated socket is refused rather than silently downgraded.
      await client.realtime.setAuth()
```

and construct with `{ config: { private: true, presence: { key: clientId } } }` (the ops channel needs `presence` too — bootstrap election reads its presence state).

- [ ] **Step 4: Retry with backoff, and never fall back to a public channel**

In the `subscribe` callback, on `CHANNEL_ERROR` / `TIMED_OUT` / `CLOSED`: increment an attempt counter, schedule `channel.subscribe()` again after `retryDelayMs(attempt)`, and report to Sentry once per transition:

```ts
        import('@sentry/nextjs').then((Sentry) => {
          Sentry.addBreadcrumb({ category: 'jam', level: 'warning', message: `${topic} → ${subscribeStatus}` })
        }).catch(() => undefined)
```

Reset the counter on `SUBSCRIBED`. There is no public-channel fallback path — do not add one.

- [ ] **Step 5: Surface the status**

In `src/app/flows/[id]/page.tsx`, take `status` from the hook and render next to the presence avatar stack (around line 1820):

```tsx
        {status !== 'live' && (
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            status === 'error' ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300'
              : 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200'}`}>
            {status === 'connecting' ? 'Connecting…' : status === 'degraded' ? 'Reconnecting…' : 'Live editing unavailable'}
          </span>
        )}
```

and, when `status === 'error'`, a one-line banner above the canvas: *"Live collaboration is unavailable — your changes still save, but teammates won't see them until this reconnects."*

- [ ] **Step 6: Run the gate and commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/lib/flows src/app/flows
git commit -m "feat(jam): private realtime channels that fail closed and say so"
```

---

### Task 12: RLS — Postgres decides who may join and who may write

**Files:**
- Create: `prisma/migrations/20260729120000_flow_jam_rls/migration.sql`
- Create: `supabase/flow-jam-rls.sql`
- Create: `src/lib/flows/__tests__/flow-topic-access-parity.test.ts`
- Modify: `docs/superpowers/specs/2026-07-29-flows-jam-hardening-design.md` (record the applied migration name)

**Interfaces:**
- Consumes: topic shapes from Task 9; role precedence from `resolveFlowRole` in `src/lib/flows/access.ts`.

- [ ] **Step 1: Write the failing parity test**

```ts
// src/lib/flows/__tests__/flow-topic-access-parity.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const sql = readFileSync(
  fileURLToPath(new URL('../../../../prisma/migrations/20260729120000_flow_jam_rls/migration.sql', import.meta.url)),
  'utf8',
)

test('the SQL encodes the same precedence as resolveFlowRole', () => {
  // Owner wins outright.
  assert.match(sql, /flow\."userId" = v_user_id[\s\S]*?return 'edit'/)
  // Same org: private is invisible, view is view (ownerless legacy stays edit).
  assert.match(sql, /visibility = 'private'[\s\S]*?return null/)
  assert.match(sql, /visibility = 'view'[\s\S]*?return case when flow\."userId" is null then 'edit' else 'view' end/)
  // Cross-org falls back to an accepted collaborator row.
  assert.match(sql, /flow_collaborators/)
})

test('both topics are policed and only editors may write ops', () => {
  assert.match(sql, /create policy .*flow_jam_read.* on realtime\.messages/i)
  assert.match(sql, /create policy .*flow_jam_write.* on realtime\.messages/i)
  assert.match(sql, /':ops'[\s\S]*?'edit'/)
})

test('the hand-appliable fallback is kept byte-identical to the migration', () => {
  const fallback = readFileSync(fileURLToPath(new URL('../../../../supabase/flow-jam-rls.sql', import.meta.url)), 'utf8')
  assert.equal(fallback.trim(), sql.trim())
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A5 flow-topic-access-parity`
Expected: FAIL — migration file does not exist.

- [ ] **Step 3: Write the migration SQL**

```sql
-- prisma/migrations/20260729120000_flow_jam_rls/migration.sql
--
-- Flow jam channel authorization. Until now `flow:<id>` was a PUBLIC Supabase
-- Realtime channel: anyone holding the anon key and a flow id could join, read
-- the whole graph stream, and inject ops. These policies make both jam topics
-- private and let Postgres decide, using exactly the precedence
-- resolveFlowRole() applies over HTTP.
--
--   flow:<id>      → any role may read and write (presence, cursors, huddle)
--   flow:<id>:ops  → any role may read; only 'edit' may write
--
create or replace function public.flow_topic_access(topic text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_flow_id text;
  v_suffix  text;
  v_user_id text;
  v_org_id  uuid;
  flow      public.flows%rowtype;
  v_role    text;
begin
  -- Parse `flow:<id>` / `flow:<id>:ops`; anything else is not ours.
  if topic is null or topic !~ '^flow:[^:]+(:ops)?$' then
    return null;
  end if;
  v_flow_id := split_part(topic, ':', 2);
  v_suffix  := split_part(topic, ':', 3);
  if v_flow_id = '' then return null; end if;
  if v_suffix <> '' and v_suffix <> 'ops' then return null; end if;

  select id, "organizationId" into v_user_id, v_org_id
  from public.users
  where "supabaseId" = auth.uid() and "isActive" = true;
  if v_user_id is null then return null; end if;

  select * into flow from public.flows where id = v_flow_id;
  if not found then return null; end if;

  -- 1. Owner → edit, always.
  if flow."userId" is not null and flow."userId" = v_user_id then
    return 'edit';
  end if;

  -- 2. Same workspace → v1 visibility semantics verbatim.
  if flow."organizationId" = v_org_id then
    if flow.visibility = 'private' then
      return null;
    elsif flow.visibility = 'view' then
      return case when flow."userId" is null then 'edit' else 'view' end;
    else
      return 'edit';
    end if;
  end if;

  -- 3. Cross-workspace → an accepted collaborator row's role.
  select role into v_role
  from public.flow_collaborators
  where "flowId" = flow.id and "userId" = v_user_id;
  if v_role in ('edit', 'view') then
    return v_role;
  end if;

  -- 4. Otherwise the flow does not exist for this viewer. Share TOKENS are
  --    deliberately not honored here: a token is redeemed over HTTP, which
  --    writes the collaborator row that case 3 then sees.
  return null;
end;
$$;

revoke all on function public.flow_topic_access(text) from public;
grant execute on function public.flow_topic_access(text) to authenticated;

drop policy if exists "flow_jam_read" on realtime.messages;
create policy "flow_jam_read"
  on realtime.messages
  for select
  to authenticated
  using (public.flow_topic_access(realtime.topic()) is not null);

drop policy if exists "flow_jam_write" on realtime.messages;
create policy "flow_jam_write"
  on realtime.messages
  for insert
  to authenticated
  with check (
    case
      when realtime.topic() like '%:ops' then public.flow_topic_access(realtime.topic()) = 'edit'
      else public.flow_topic_access(realtime.topic()) is not null
    end
  );
```

- [ ] **Step 4: Copy it to the hand-appliable fallback**

```bash
cp prisma/migrations/20260729120000_flow_jam_rls/migration.sql supabase/flow-jam-rls.sql
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test 2>&1 | grep -A5 flow-topic-access-parity`
Expected: PASS.

- [ ] **Step 6: Verify the migration applies from zero**

Run against the local CI-repro Postgres (per the repo's CI-mode recipe):
`DATABASE_URL=postgresql://localhost:5432/ci_repro npx prisma migrate deploy`
Expected: applies cleanly. **If it fails on privileges for `realtime.messages`**, that is the documented risk — the `realtime` schema may not exist locally. In that case wrap only the two `create policy` statements in a `do $$ begin ... exception when others then raise notice ...` guard, note it in the migration comment, and record in the plan's ledger entry that `supabase/flow-jam-rls.sql` must be applied by hand in the Supabase SQL editor.

- [ ] **Step 7: Run the gate and commit**

```bash
npm run typecheck && npm run lint && npm test
git add prisma/migrations supabase/flow-jam-rls.sql src/lib/flows/__tests__/flow-topic-access-parity.test.ts docs/superpowers/specs
git commit -m "feat(jam): RLS so Postgres authorizes jam channel joins and writes"
```

---

### Task 13: Full gate, docs, and the live checklist

**Files:**
- Modify: `.superpowers/sdd/progress.md`
- Modify: `docs/superpowers/plans/2026-07-29-flows-jam-hardening.md` (this file — check off the live checklist)

- [ ] **Step 1: Run the complete local gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green, no skipped suites.

- [ ] **Step 2: Run the CI-mode repro**

Follow the repo's `ci_repro` recipe: local Postgres, `prisma migrate deploy` from zero, then the full DB-backed suite and a CI-mode build. Expected: green, and `npx prisma migrate diff` reports no drift.

- [ ] **Step 3: Record the outcome in the ledger**

Append a `=== JAM HARDENING ===` entry to `.superpowers/sdd/progress.md` covering: what shipped per workstream, the migration name, whether the RLS policies applied via `migrate deploy` or need the manual `supabase/flow-jam-rls.sql` step, and the deferred items.

- [ ] **Step 4: Commit and push**

```bash
git add .superpowers/sdd/progress.md docs/superpowers/plans
git commit -m "docs: record jam hardening outcome"
git push origin main
```

- [ ] **Step 5: Hand the live checklist to the user**

Two browsers, two accounts, on the deployed app:
1. Admin opens a flow → Jam → invites a brand-new email address. Invitation email/link arrives.
2. Invitee opens the link signed-out, creates their account via Google, and **lands on the flow** (not `/dashboard`).
3. Both see each other in the presence stack; the status pill reads nothing (live).
4. Both on Canvas view: cursors visible both directions, labelled with names.
5. One switches to Inline: the other's roster shows "Inline view — follow"; clicking follows.
6. One drags a node: the other sees it move continuously, then settle.
7. Owner sets the share link to **Can view**, opens it in a third session: that guest sees cursors and receives edits, and their own edits do not propagate (ops write refused).
8. Kill the network on one tab briefly: status shows "Reconnecting…", then returns to live without a reload.

---

## Self-Review

**Spec coverage:** A1→Task 1; A2→Task 2; A3→Task 3; A4→Task 4; A5→Task 5; A6→Task 2 Step 7; B topics→Tasks 9, 10; B SQL→Task 12; B client/private/fail-closed→Task 11; B hook split→Task 10; B observability→Task 11; C pruning→Task 6; C trailing flush→Task 6; C cross-view follow→Task 7; C live drag→Task 8; C "who is on what" is already shipped via `remoteSelections` and is extended by Task 7's roster labels; testing→fake transport in Task 10, gates in every task, live checklist in Task 13.

**Type consistency:** `pruneCursors` takes `Set<string> | null` from Task 6 onward and is consumed that way in Task 10. `CursorSpace` is the type used for both cursor spaces and the presence `view` field (Tasks 6–8). `JamStatus`, `nextJamStatus`, `retryDelayMs` are defined in Task 9 and consumed unchanged in Tasks 10–11. `DragPreview` / `applyDragPreview` / `pruneDragPreview` are defined in Task 8 and used only there. `safeReturnPath` is defined in Task 1 and consumed in Tasks 2 and 5. `buildInviteLink` is defined in Task 2 and consumed in Task 3 via the API.

**Known risk carried forward:** Task 12 Step 6 may reveal that the migration role cannot create policies on `realtime.messages`; the fallback path is written into that step rather than left as a surprise.
