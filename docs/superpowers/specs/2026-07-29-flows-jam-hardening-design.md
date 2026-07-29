# Flows Jam — Hardening Multiplayer, Cursors, and the Join Path

**Date:** 2026-07-29
**Status:** Approved (design)
**Owner:** James McDaniel

## Problem

Two people cannot get into the same flow jam at the same time, and remote
cursors never appear. Reading the stack end to end, this is three separate
failures stacked on top of each other — the realtime layer is only the third.

### 1. A second person cannot reach the flow at all

Every Supabase signup fires `handle_new_user` (`supabase/handle-new-user.sql`),
which creates a **brand-new organization** and makes the signer-up its ADMIN.
Two people who sign up independently therefore sit in two different workspaces,
and a `shared` flow is invisible across that boundary. The only two bridges are
a workspace invitation or a `?share=` link, and both break:

- **Workspace invites lose their deep link.** Production is invite-only
  (`AUTH_ALLOW_PASSWORD=false`), so `/invite/<token>`'s "Create your account"
  button goes to `/auth/signup`, which `src/lib/supabase/middleware.ts:54-59`
  redirects to `/auth/login` after setting **`url.search = ''`** — discarding
  the `return_to` that carries the invite token. The invitee signs in with
  Google, lands on `/dashboard` in a fresh solo workspace, and never joins.
  The same clearing happens at `middleware.ts:69-74` when an already-signed-in
  user hits a login URL carrying `return_to`.
- **Acceptance always lands on `/dashboard`.** `src/app/invite/[token]/page.tsx`
  hardcodes the post-accept destination, so an invite sent *from a jam* drops
  the person on the dashboard rather than the flow they were invited to.
- **The Jam dialog can only invite existing members.** It lists
  `/api/organizations/members`, which in a one-person workspace is empty, so the
  dialog offers no way to bring in a new human. Workspace invitations exist but
  live in Settings and are ADMIN-only.
- **The invite link is usually a dead link.** `jam-dialog.tsx` appends
  `?share=<token>` only when a token already exists; the toggle that mints one
  sits below the invite row. The copied link is normally a bare `/flows/<id>`,
  which a non-member resolves to a 404.

### 2. The realtime channel is unauthenticated and unmonitored

`use-flow-collab.ts` opens `supabase.channel('flow:<id>')` — a **public**
channel. Any client holding the anon key and a flow id can join, read the entire
graph stream, and inject ops; nothing server-side checks that the joiner can
access the flow. Separately, `subscribe()` (`use-flow-collab.ts:239-248`)
ignores `CHANNEL_ERROR`, `TIMED_OUT`, and `CLOSED`, so every transport failure
is silent — there is no state to inspect when "the jam doesn't work".

### 3. Cursor-specific defects

- Cursors are dropped unless the sender's `clientId` is in the presence set
  (`pruneCursors` + `use-flow-collab.ts:179`), so any presence hiccup erases
  every cursor even while packets keep arriving.
- Cursors are filtered by `space === view` (`page.tsx:628`). A teammate on the
  Inline view and one on the Canvas view are **mutually invisible with no
  indication why**.
- The cursor throttle is leading-edge only with no trailing flush, so a cursor
  that stops moving rests at a stale position.

## Decisions (locked)

| Fork | Decision | Rationale |
|---|---|---|
| Realtime engine | **Stay on Supabase Realtime** | Already wired; no new vendor. |
| Channel authorization | **Private channels + RLS on `realtime.messages`** | Server-side proof of flow access; the public channel is an eavesdrop/injection hole. |
| View-only enforcement | **Split topics** — `flow:<id>` and `flow:<id>:ops`, INSERT on `:ops` restricted to editors | Real enforcement instead of client-side honor system. |
| Policy delivery | **Prisma raw-SQL migration**, with `supabase/flow-jam-rls.sql` checked in as manual fallback | Ships with the app; a privilege failure breaks the deploy loudly rather than shipping a broken jam. |
| Cross-view cursors | **Presence carries `view`; roster shows it; click to follow** | Honest about the split; no fragile coordinate translation. |
| Private-channel failure | **Fail closed** | A security control that silently downgrades to a public channel is worse than an outage. |
| Signup model | **Unchanged** (one org per signup) | Invitations move people between workspaces; that is the existing model. |

Not chosen: Liveblocks/Yjs (new vendor); auto-switching a joiner's view to match
the majority (silently moves the user); translating inline pixel coordinates to
DAG coordinates (approximate and fragile).

## Workstream A — Invite & join (ships first)

**A1. Preserve `return_to` in middleware.** `src/lib/supabase/middleware.ts`
keeps a validated same-origin `return_to` across both redirects: the
signup→login bounce (line 57) and the signed-in→auth-page bounce (line 72),
where an existing `return_to` becomes the destination instead of `/dashboard`.
Validation: must start with a single `/`, no protocol-relative `//`.

**A2. Invites land on the flow.** `/invite/<token>` accepts an optional
`?next=<same-origin path>` and navigates there after acceptance (full reload
preserved, so server auth context picks up the new workspace).
`POST /api/organizations/invitations` accepts an optional `next`, validates it
the same way, and appends it to both the returned link and the emailed link.

**A3. The Jam dialog invites people who are not yet users.** An email row is
added next to the member list:
- **Admin caller** → `POST /api/organizations/invitations` with
  `next=/flows/<id>`; the dialog shows the copyable link and whether email
  delivery actually succeeded (`emailSent`).
- **Non-admin caller** → explicit, plain-English routing to the guest share
  link rather than a dead end or a silent 403.

**A4. Honest invite links.** When the flow is shareable and no share token
exists, the link row states that only workspace members can open it and offers a
one-click *Make this link work for anyone I send it to* that mints the token.
With a token present, the granted role (view/edit) is stated on the link row
itself. Minting stays an explicit user action — never a side effect of opening
the dialog.

**A5. Real errors when a join fails.** The builder's not-found state
distinguishes: no access · link rotated/expired · signed in as the wrong account
(with a switch-account action). `GET /api/flows/[id]` returns the discriminating
code **only when a `share` param was presented** — a stranger with no token
still gets an undifferentiated 404, so flow existence never leaks.

**A6. Regression-guard the invite notification href.** `notificationHref`
already prefers the persisted `link`; add a test pinning `flow.jam_invite` →
`/flows/<id>` so the earlier fix cannot silently regress.

## Workstream B — Server-authorized realtime

### Topics

| Topic | Carries | Read | Write |
|---|---|---|---|
| `flow:<id>` | presence, cursors, huddle signaling, `saved` bus | any role | any role |
| `flow:<id>:ops` | graph change-sets (`ops` / `full` bootstrap) | any role | **editors only** |

A view-only participant keeps presence, cursors, and voice, and still *receives*
edits, but cannot emit graph ops — enforced by Postgres, not by the client.

### SQL (Prisma raw-SQL migration + `supabase/flow-jam-rls.sql`)

`public.flow_topic_access(topic text) returns text` — `security definer`,
`search_path = public`:

1. Parse `flow:<id>` / `flow:<id>:ops`; anything else → `null`.
2. Map `auth.uid()` → `public.users."supabaseId"` → the caller's user row.
3. Resolve the role with the same precedence as `resolveFlowRole`: owner →
   `edit`; same org → `private` = `null`, `view` = `view` (ownerless legacy =
   `edit`), else `edit`; else a `flow_collaborators` row's role; else `null`.

Policies on `realtime.messages` for role `authenticated`:

- `SELECT` — `public.flow_topic_access(realtime.topic()) is not null`
- `INSERT` — base topic: access is not null; `:ops` topic: access = `'edit'`

The function is the single source of truth for channel access; `resolveFlowRole`
stays the source of truth for HTTP. A test asserts the two encode the same
precedence so they cannot drift silently.

**Deploy risk (accepted):** the migration role must be able to create policies on
the `realtime` schema. If it cannot, `prisma migrate deploy` fails the Vercel
build — visible, not silent — and `supabase/flow-jam-rls.sql` is applied by hand
in the Supabase SQL editor.

### Client

`{ config: { private: true, presence: { key: clientId } } }` on both channels,
with `await supabase.realtime.setAuth()` before subscribe. Authorization failure
surfaces as an explicit "live collaboration unavailable" state — there is no
fallback to a public channel.

### Hook split

`use-flow-collab.ts` (343 lines: presence + op sync + cursors + bus) would not
stay readable with two channels. It becomes a composition over four focused
units, with its public API unchanged so `page.tsx` is untouched:

| Unit | Responsibility |
|---|---|
| `flow-channels.ts` | Topic construction/parsing, authenticated subscribe, status machine, backoff |
| `use-flow-presence.ts` | Presence payload, roster, deduped participants, selection/huddle/view fields |
| `use-flow-graph-sync.ts` | `:ops` channel — diff/apply/bootstrap election |
| `use-flow-cursors.ts` | Cursor stream: throttle, trailing flush, TTL prune |
| `use-flow-collab.ts` | Composition + the API `page.tsx` consumes |

### Observability

`subscribe()` handles `CHANNEL_ERROR` / `TIMED_OUT` / `CLOSED`: auto-resubscribe
with capped exponential backoff, a Sentry breadcrumb per failure, and a
`status: 'connecting' | 'live' | 'degraded' | 'error'` exposed to the page — a
jam status pill in the header and a reconnect banner when degraded.

## Workstream C — Seeing each other work

- **Cursors survive presence hiccups.** Prune on TTL always; presence-gate only
  when the presence set is non-empty.
- **Trailing flush** on the cursor throttle so a parked cursor rests at its true
  position.
- **Cross-view awareness.** Presence carries `view: 'inline' | 'canvas'`. The
  roster and Jam dialog show "Sam — Canvas view"; clicking follows them
  (switches your view and centers on their cursor/selection).
- **Live drag.** Node drags currently teleport on release. An ephemeral `drag`
  event streams `{nodeId, x, y}` during the drag; receivers apply it to remote
  canvas positions **without** touching graph state or undo history, and the
  real op on release supersedes it.
- **Who is on what.** The avatar stack/roster shows each participant's current
  step ("editing Send Slack message"), reusing the existing selection rings.

## Testing

- **Fake realtime transport** — an in-memory channel double so two simulated
  clients can be driven in tests: ops converge, a joiner bootstraps from the
  elected answerer, view-only writes are rejected, cursors upsert/prune, and a
  view mismatch produces the follow affordance.
- **Pure units** — topic construction/parsing, the role-precedence parity test
  between `flow_topic_access` and `resolveFlowRole`, cursor prune/trailing
  flush, `return_to`/`next` sanitization, share-link construction,
  `notificationHref` for `flow.jam_invite`.
- **Routes** — smoke cases for the invite/share/invitation endpoints (new authed
  GET routes must be registered in the route-smoke harness or its completeness
  test fails).
- **Gates** — typecheck + eslint + full test suite locally; CI-mode repro
  against local Postgres (`ci_repro`) including migrate-from-zero, since this
  adds a migration; `prisma migrate diff` for drift.
- **Live verification** — two real browser sessions on the deployed app,
  performed by the user: invite a non-member by email, accept, land on the flow,
  see presence, cursors, and live edits both ways; then repeat with a view-only
  guest and confirm their ops are rejected.

## Sequencing

**A → C → B → push.** A and C make "two people in a jam" testable without
waiting on the RLS migration; B then closes the door. Each workstream is
independently shippable and independently verifiable.

## Out of scope

- Changing the one-organization-per-signup trigger.
- Collaborator removal UI and revoke-on-rotate for already-accepted grants
  (deferred from the v1.5 gap close-out; still deferred).
- Anonymous (signed-out) jam access.
- A managed SFU/TURN change — huddle transport is unchanged by this work.
- CRDT/Yjs-style convergence guarantees; op-merge semantics stay as shipped.
