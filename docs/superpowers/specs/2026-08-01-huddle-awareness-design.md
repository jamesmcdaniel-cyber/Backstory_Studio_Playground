# Huddle Awareness — In-Page Toast and Explicit Ring

**Date:** 2026-08-01
**Status:** Approved (design) — pending implementation plan
**Owner:** James McDaniel
**Predecessor:** `2026-07-31-flow-huddle-turn-and-recovery-design.md`, whose
follow-on list ranked this first.

## Problem

A huddle is only discoverable if you already have the flow open, and even then
only as a bar that silently appears at the bottom of the canvas. Someone in
another tab, scrolled into the copilot, or simply not on the flow will never
know a conversation started. The voice feature works; nobody arrives at it.

## Decisions

| Area | Decision | Why |
|---|---|---|
| Off-page audience | **Explicit ring — the starter picks who** | Zero spam by construction. A derived audience (owner + collaborators + recent publishers) guesses with data collected for other purposes, and its failure mode is silence for the person you most wanted. |
| Transport | **Reuse `POST /api/flows/[id]/invite`** | Rate limiting, tenancy scoping, private-flow refusal, self-exclusion, and audit already work there and are already tested. |
| On-page alert | **Sonner toast on the zero-to-one transition** | Presence already broadcasts `inHuddle`; no backend needed. |
| Sound | **Not in v1** | Browsers block audio without a prior gesture on the page. Doing it right needs a preference plus an unlock gesture — a separate piece of work. |
| Ring permission | **Editors only (unchanged `flow.write` gate)** | That gate is what stops a view-only participant using the notification system as a megaphone. |

## Section 1 — In-page toast

A new pure module `src/lib/flows/huddle-alerts.ts`:

```
detectHuddleStart(
  prev: HuddleParticipant[],
  next: HuddleParticipant[],
  selfClientId: string,
  selfJoined: boolean,
): string | null
```

where `HuddleParticipant = { clientId: string; name: string; inHuddle?: boolean }`.

Policy:

- **Self is filtered out of both lists** by `selfClientId` before counting. This
  removes any dependence on the ordering of `setJoined` and `setInHuddle`
  inside `join()`.
- Fires only on **zero-to-one**: no other participant was in the huddle, and now
  at least one is. A five-person huddle therefore produces one toast, not four.
  (Two people flipping `inHuddle` in the same presence tick still counts as one
  start, and names the first of them.)
- Returns `null` when `selfJoined` — you are in the huddle, you can see it.
- Returns the starter's display name, otherwise `null`.

The flow page holds the previous participant list in a ref and **seeds it from
the first presence snapshot**, so opening a flow with a huddle already running
does not toast "started" about a conversation that began ten minutes ago. That
case is already served by the visible huddle bar.

The toast is a Sonner toast with a **Join** action calling `huddle.join()`.
Sonner is the app-wide toast, so placement and stacking come for free.

## Section 2 — Explicit ring

`POST /api/flows/[id]/invite` gains one optional body field:

```
kind: z.enum(['jam', 'huddle']).default('jam')
```

Defaulted, so every existing caller is unaffected. It selects copy through a
second pure export of `huddle-alerts.ts`:

```
ringNotification(kind, inviterName, flowName, flowId): {
  type: string; level: 'action'; title: string; body: string; link: string
}
```

- `jam` — today's copy, unchanged: type `flow.jam_invite`, "*{inviter} invited
  you to jam*", "*Join "{flow}" to edit it together in real time.*"
- `huddle` — type `flow.huddle_started`, "*{inviter} started a huddle*",
  "*Join the voice huddle on "{flow}".*"

Both link to `/flows/{flowId}`.

The audit action becomes `flow.huddle_ring` for `kind: 'huddle'` and stays
`flow.invited` for `jam`, so ringing is distinguishable from inviting after the
fact.

Everything else in that route is untouched: the 10/min per-inviter rate limit,
the org-scoped recipient lookup, the `assertFlowEditable` check, the
private-flow refusal, and dropping the caller from their own recipient list.

## Section 3 — Dialog wiring

`jam-dialog.tsx` already receives `huddleJoined` and already renders the member
multi-select and send button. Two changes:

- `sendInvites` posts `kind: huddleJoined ? 'huddle' : 'jam'`.
- When `huddleJoined`, the button reads "Ring N teammates to the huddle" and its
  success toast says they were rung rather than invited.

No new picker, no new dialog, no new endpoint.

## Files

| File | Change |
|---|---|
| `src/lib/flows/huddle-alerts.ts` | **New** — `detectHuddleStart`, `ringNotification` |
| `src/lib/flows/__tests__/huddle-alerts.test.ts` | **New** |
| `src/app/api/flows/[id]/invite/route.ts` | `kind` field, copy via `ringNotification`, audit action |
| `src/app/flows/[id]/page.tsx` | Previous-participants ref, toast effect |
| `src/components/flows/jam-dialog.tsx` | Send `kind`, relabel button and success toast |

## Testing

- **Unit:** every `detectHuddleStart` branch — zero-to-one, one-to-two (silent),
  self excluded, `selfJoined` suppression, empty-to-empty; both `ringNotification`
  variants including that `jam` copy is byte-identical to today's.
- **Regression:** `src/components/flows/__tests__/jam-invite.test.tsx` must keep
  passing unchanged, but note it only exercises the workspace-invitation POST —
  it never posts to `/api/flows/[id]/invite`. The default-`kind` guarantee
  therefore needs its own new test asserting the dialog sends `kind: 'jam'`
  when no huddle is live.
- **Manual:** two browser profiles on one flow. Start a huddle in A and confirm
  B toasts once with a working Join. Add a third participant and confirm B does
  not toast again. Ring from A's dialog and confirm B's notification bell and
  web push both carry huddle copy.

## Accepted limitations

1. **A huddle where nobody rings anyone stays invisible off-page.** The
   deliberate cost of an explicit audience.
2. **View-only participants cannot ring**, because the endpoint is editor-gated
   and widening it would open a notification vector.
3. **No sound**, per the decision table.

## Out of scope (follow-ons)

Unchanged from the predecessor, minus this item: push-to-talk and device
pickers; per-peer volume and local mute; SFU migration beyond ~6 participants;
huddle transcript feeding the copilot; server-side ICE credential caching.
