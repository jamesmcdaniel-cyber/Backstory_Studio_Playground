# Recent flows on the Assistant home

**Date:** 2026-08-11
**Status:** Approved

## Problem

The Assistant home (`/dashboard`) is the first screen after sign-in, but it offers no
route back into work in progress. To reopen the flow you were editing five minutes ago
you have to go to `/flows`, find the card in a paginated grid, and click it. The most
common intent on landing — "keep going on what I was building" — costs the most clicks.

## Solution

Show the three most recently edited flows as mini cards directly beneath the Assistant's
suggestion chips. Each card links straight to that flow's canvas at `/flows/[id]`.

## Scope

### Ordering

Most recent means **last edited** — the flow's `updatedAt`. `GET /api/flows` already
returns `orderBy: { updatedAt: 'desc' }`, so the home page takes the first three rows of
the existing response. No new tracking, no new endpoint, and the ordering is workspace
truth: a flow a collaborator edited moves up for everyone who can see it.

Rejected: a per-browser "recently opened" list in localStorage (invisible on a new
device, needs new state on the canvas page) and ordering by last run (biases toward
published flows, which is the opposite of work-in-progress).

### Placement and lifecycle

The row lives inside the existing `{!started && …}` block in
`src/app/dashboard/page.tsx`, immediately after the suggestion chips. It shares the
chips' lifecycle exactly: visible on the landing state, gone as soon as a conversation
starts (`thread.length > 0 || busy || failure !== null`). The answer thread stays
uncluttered, and the row is one "New chat" away when it is wanted again.

### Card anatomy

Three cards in a `grid-cols-1 sm:grid-cols-3` grid:

- accent gradient bar across the top
- the flow's emoji `icon`, or the lucide `Workflow` glyph when `icon` is empty, in a
  tinted accent chip
- the flow name, truncated to one line
- `edited 2h ago`

Card accent colors come from the same `cardAccent(id)` hash the Flows grid uses, so a
flow shows the **same** color on both screens. The `CARD_ACCENTS` palette and the
`cardAccent` hash move out of `src/app/flows/page.tsx` into `src/lib/flows/card-accent.ts`
and both call sites import it — a second copy of a six-entry Tailwind palette would drift.

Above the grid sits a header row: a `RECENT FLOWS` mono label on the left (matching the
greeting's typographic treatment) and an "All flows" link to `/flows` on the right.

### States

| Condition | Render |
| --- | --- |
| Loading | Three skeleton cards at the same footprint, so nothing shifts when data lands |
| 1–3 flows | That many cards |
| Zero flows | Nothing — a new workspace sees only the chips, not an empty shelf |
| Fetch failed or non-OK | Nothing, silently, the way `useWorkspaceFlows` degrades |

The row never shows an error state. It is a shortcut, not a primary surface; a failure
to load it must not compete with the composer for attention.

### Shared helpers

Relative-time formatting already exists as two page-local copies
(`src/app/approvals/page.tsx`, `src/app/agents/assistant-panel.tsx`) with different
output formats. Rather than add a third, this adds `src/lib/relative-time.ts` exporting
`relativeTime(iso: string): string` — `just now`, `5m ago`, `2h ago`, `3d ago`, then an
absolute date past a week. The new component uses it. The two existing pages are left
alone: their formats differ and rewriting them is unrelated to this change.

## Files

| File | Change |
| --- | --- |
| `src/lib/flows/card-accent.ts` | New. `CARD_ACCENTS` + `cardAccent(id)`, moved from the Flows page |
| `src/lib/relative-time.ts` | New. `relativeTime(iso)` |
| `src/components/dashboard/recent-flows.tsx` | New. Client component: fetch, states, cards |
| `src/app/dashboard/page.tsx` | Render `<RecentFlows />` after the suggestion chips |
| `src/app/flows/page.tsx` | Import the accent helpers instead of defining them |

## Testing

- `src/lib/__tests__/relative-time.test.ts` — boundaries at 60s, 60m, 24h, 7d
- `src/lib/flows/__tests__/card-accent.test.ts` — same id always yields the same accent;
  every returned recipe is a full literal class string
- `src/components/dashboard/__tests__/recent-flows.test.tsx` — with a stubbed `fetch`:
  three cards render with `href="/flows/<id>"`, at most three render when the API
  returns more, an empty list renders nothing, and a rejected fetch renders nothing

Component tests follow the existing convention: `@/test-support/jsdom-env`,
`node:test`, and `@testing-library/react`.

## Out of scope

- Pinning or reordering the quick-start cards
- Showing recent agents, templates, or runs alongside flows
- Any change to `/api/flows` — the existing response already carries every field needed
