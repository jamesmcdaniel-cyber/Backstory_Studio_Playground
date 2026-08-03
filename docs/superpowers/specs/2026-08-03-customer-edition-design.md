# Customer Edition — Design

**Date:** 2026-08-03
**Status:** Approved, ready for planning
**Target repo:** https://github.com/jamesmcdaniel-cyber/Backstory_customers.git

## Goal

Ship a customer-facing build of the platform with the same functionality as
Backstory Studio, minus two things:

1. Automatic addition of templates to the catalogue (the AI generation pipeline).
2. The operator console — cross-workspace staff administration.

The customer build lives in its own repo, with its own database and Vercel
project, and must keep receiving the features shipped upstream without hand-porting.

## Approach: gated mirror, not a hard fork

`Backstory_Studio` remains the source of truth and gains an **edition** concept
defaulting to `internal`, so the existing build is unchanged. `Backstory_customers`
is a full mirror of the tree whose only permanent diff is one line:

```
src/lib/edition.config.ts
  upstream:  export const EDITION: Edition = 'internal'
  fork:      export const EDITION: Edition = 'customer'
```

`git merge upstream/main` therefore stays clean forever, and the ongoing cost per
upstream feature is approximately zero.

### Why a committed constant, not an env var

An env var can be omitted on a fresh deploy and would **fail open** — silently
granting a customer deployment the staff console and the generation pipeline. A
committed constant cannot be forgotten. It also works uniformly across the three
runtimes that need it (Next.js server, browser bundle, and the `tsx` worker
process), where a `NEXT_PUBLIC_*` var would need separate handling in the worker.

The module exports a plain constant with no imports, so it is safe in edge
middleware, React client components, and the worker alike.

`src/lib/edition.ts` wraps it:

```ts
export type Edition = 'internal' | 'customer'
export function appEdition(): Edition
export function isCustomerEdition(): boolean
export function isInternalEdition(): boolean
```

A `APP_EDITION` env override is permitted **only** when `NODE_ENV !== 'production'`,
so tests can exercise both editions in one process without allowing a production
deploy to be flipped by configuration.

## Rejected alternatives

- **Hard fork (delete the code).** Cleanest artifact, but the two trees diverge
  permanently and every future feature must be hand-ported. Rejected because this
  repo ships continuously; the recurring sync cost dominates the one-time cleanup gain.
- **Hard fork with an `upstream` remote for cherry-picks.** Same divergence cost,
  paid per port instead of once, with conflicts concentrated exactly where the
  deleted code used to be.

## Enforcement points

Four layers, each at an existing chokepoint rather than scattered through handlers.

| Layer | Mechanism | File |
|---|---|---|
| API routes | New `internalOnly?: boolean` option → 404 in customer edition | `src/lib/server/api-handler.ts` |
| Pages | `notFound()` before the permission redirect | `src/app/admin/layout.tsx` |
| Edge | `/admin` short-circuited to 404 in customer edition | `src/middleware.ts` |
| Jobs | Early return in the sweep; queue spec not registered | `src/lib/workers/runtime.ts`, `src/app/api/cron/dispatch/route.ts` |

The API gate is checked **before** authentication, so a gated route is
indistinguishable from a route that does not exist. This avoids advertising the
internal surface to a customer tenant.

## Scope A — automatic template generation goes dark

The generation pipeline is gated off in its entirety. Code is retained (not
deleted) so upstream merges stay clean.

### Server

- `/api/template-proposals` (GET), `/api/template-proposals/[id]/accept`,
  `/api/template-proposals/[id]/dismiss` → `internalOnly`.
- `sweepTemplateGeneration` — skipped in the daily cron tick. The `generatedOrgs`
  field stays in the response body as an empty array rather than disappearing, so
  the response contract is edition-independent.
- `maybeGenerateOnGateClear` — the fire-and-forget calls in
  `src/app/api/nango/status/route.ts` and `src/app/api/nango/webhook/route.ts`
  become no-ops. The guard belongs inside `maybeGenerateOnGateClear` itself, not at
  the two call sites, so a future third caller inherits it.
- `TEMPLATE_GENERATION` and `TEMPLATE_GENERATION_DEAD_LETTER` worker specs are not
  registered in the customer edition.

### Client

- `ProposalsProvider` skips its fetch effect entirely and reports
  `{ proposals: [], loaded: true }`. It stays mounted so every `useProposals()`
  consumer keeps working — removing the provider would make consumers throw
  ("must be used within ProposalsProvider").

**The provider is the only client-side edit required.** Every consumer already
guards on emptiness, so an inert provider cascades correctly with no further
changes — verified during planning:

- `RecommendationsBar` opens with `if (!proposals.length) return null`.
- The notification bell renders its proposals section under
  `{proposals.length > 0 && ...}`, and its badge is `unread + proposals.length`,
  which is arithmetically correct against an empty array.
- The "Suggested for you" badge on `flow-template-card.tsx` and "Made for your
  team" on the connect page become unreachable. Left in place; harmless.

This is a deliberate design property rather than a coincidence: gating one
provider, instead of editing each of its consumers, is what keeps the customer
edition's diff small enough to merge cleanly.

### Not affected

The catalogue itself is untouched: browse, search, install, the shipped built-in
agent and flow templates, manual authoring, versioning and restore all work
exactly as they do upstream. `createTemplate` keeps its `source` parameter; the
`'ai_generated'` value simply never occurs in a customer deployment.

Existing rows with `source='ai_generated'` — if any were ever created — remain
browsable and installable, appearing as ordinary org templates. No data migration
is required.

## Scope B — operator console goes dark

- `/admin/catalogue` page and the `/admin` layout → `notFound()`.
- `/api/catalogue/staff` (GET, PATCH) → `internalOnly`.
- `/api/catalogue/review` and `/api/catalogue/review/[id]` → `internalOnly`.
- `/api/catalogue/entries` and `/api/catalogue/entries/[id]` → `internalOnly`.
- The `PLATFORM_STAFF_EMAILS` bootstrap in `src/lib/supabase/auth-utils.ts`
  becomes a hard no-op in the customer edition.

That last one is the load-bearing item. Today `applyStaffBootstrap` promotes an
allowlisted email to `platformRole: 'reviewer'` **and flips their workspace to
`kind: 'internal'`**. In a customer deployment that is a privilege-escalation
path reachable purely through environment configuration, so it must be
unreachable in code, not merely unset.

### Interaction with the existing RBAC model

`src/lib/authz/permissions.ts` already expresses this boundary: `template.submit`
and the `catalogue.review` / `publish` / `takedown` bundle are granted only to
users in orgs whose `kind` is `internal` or `partner`. `Organization.kind`
defaults to `'customer'`. With the staff bootstrap inert, no org in a customer
deployment can ever become `internal`, so these permissions are already
unreachable by role resolution.

The edition gate is therefore defence in depth over a correct existing model, not
a substitute for one. Catalogue **submission** routes (`/api/catalogue/submissions`)
are deliberately left ungated — they are already inaccessible via RBAC, and
gating them would be redundant surface area to maintain.

## Scope C — onboarding collapses to two steps

`src/app/connect/page.tsx` today is a three-stage stepper:
*Connect your tools → Your data takes shape → Your AI goes live*, where stage 2
**is** the proposal inbox. In the customer edition it becomes
*Connect your tools → Your AI goes live*.

Three specific hazards, each an explicit implementation task:

1. **The auto-redirect must be rewired.** It currently fires on
   `gate?.meetsGate && openProposals === 0` (lines 116–124). Removing the
   `/api/template-proposals` fetch without changing this condition leaves
   `openProposals` at `null` forever, so onboarding **hangs and never forwards to
   the dashboard**. In the customer edition the condition is `entitlementDone` alone.

2. **The 3-integration gate must be dropped, not merely hidden.** `MIN_INTEGRATIONS_FOR_TEMPLATES`
   exists solely to gate template generation. `unlockedStage` currently reads
   `!entitlementDone ? 0 : gate?.meetsGate ? 2 : 1`. Retaining that in a build with
   no generation would block customers behind a meter that serves no purpose. In
   the customer edition, entitlement is the only gate: `entitlementDone ? 1 : 0`.

3. **`STAGES` is a fixed tuple** (`as const`, length 3) driving the stepper render.
   It becomes edition-derived, and the stage indices used by the redirect and
   `unlockedStage` clamp move with it.

`/api/integrations/count` keeps working and stays ungated — it is a plain
read-only "what have you connected" count gated on `flow.read`, still used by the
internal build. It simply loses its only customer-edition caller.

## Scope D — usage and spend: deliberately unchanged

**The customer build's usage and spend surfaces are identical to upstream.** This
is a deliberate decision made after investigation, recorded here so it is not
mistaken for an oversight.

The original brief asked for a build without "insights into what users are using
and how spend is being tracked". Investigation established that the operator-level
view this implies **does not exist in the codebase**:

- There is no cost or pricing code anywhere — no `costUsd`, no per-token pricing
  table, no billing provider. "Spend" is measured exclusively in tokens. The
  `BillingSection` in `src/app/settings/page.tsx` is a plan badge and a `mailto:` link.
- There are no usage tables, no analytics or adoption dashboard, and no rollup
  cron. Month-to-date totals live in Redis; the only persisted columns are
  `AgentExecution.inputTokens` / `.outputTokens`.
- Every usage surface is already org-scoped by the tenant guard. The complete
  visible surface is four small items: an orphaned `GET /api/usage` with zero
  client callers, the sidebar credits meter, a `usage` block in `/api/snapshot`,
  and that Billing section.

The cross-workspace operator surface that *does* exist is the staff catalogue
console, which Scope B covers.

The decision, confirmed with the user after presenting the above, is to change
nothing here. Consequence, stated plainly: this half of the original brief was
already satisfied by the existing architecture.

### Metering must keep running

Independently of what is displayed, token metering is **load-bearing and stays
in every edition**:

- `src/lib/usage/budget.ts` is imported by 10 files and enforces the monthly token
  ceiling. An unset limit does **not** mean unlimited.
- `src/lib/usage/ai-guard.ts` bundles rate limiting and provider-availability 503s
  with the budget check across 10 interactive AI endpoints. Disabling it would
  silently un-rate-limit every LLM endpoint.
- `AGENT_MAX_RUN_TOKENS` (2M) and `AGENT_MAX_TREE_TOKENS` (20M) in
  `execute-agent.ts` are the runaway-agent backstop.

No edition gate touches any of this.

## Testing

The existing suite runs unchanged in both repos under the internal edition, so
current coverage — including the route-smoke completeness self-checks — is
unaffected.

One new test file, `src/lib/__tests__/edition-gates.test.ts`, asserts the customer
edition specifically, using the non-production `APP_EDITION` override:

- Every route declared `internalOnly` returns 404 in the customer edition.
- A representative sample of ungated routes still returns 200, proving the gate
  is selective rather than blanket.
- `applyStaffBootstrap` is a no-op in the customer edition **even with
  `PLATFORM_STAFF_EMAILS` set to the user's own address** — the privilege-escalation
  regression test.
- `maybeGenerateOnGateClear` and `sweepTemplateGeneration` perform no writes.
- The connect page's redirect condition resolves truthy on entitlement alone, so
  onboarding cannot hang.

A completeness check enumerates routes carrying `internalOnly` and fails if the
set drifts from the documented inventory, so a future internal-only route cannot
be added without a conscious decision about the customer edition.

No schema change, no migration, and no test deletions — gating rather than
deleting is what keeps merges clean.

## Repo setup

`Backstory_customers` is currently an empty repo. It receives the full history of
`Backstory_Studio` (preserving provenance), plus one commit flipping
`edition.config.ts` and updating the README. `Backstory_Studio` is configured as
an `upstream` remote.

Deployment is a separate Vercel project with its own database, its own Supabase
project, and its own cron entries. `PLATFORM_STAFF_EMAILS` is left unset there —
belt and braces alongside the code-level no-op.

## Non-goals

- **Branding.** The customer build keeps the current product identity. The
  in-flight `SprintIQ` / `Backstory` naming split is a separate concern.
- **Deleting the gated code.** Retained deliberately; deletion is what makes
  merges expensive.
- **Schema changes.** `TemplateProposal` and all catalogue models stay.
- **Per-customer isolated deployments.** The assumption is one multi-tenant
  customer deployment where every org is `kind: 'customer'`.

## Open assumptions

Recorded so they can be corrected cheaply:

1. `Backstory_customers` is a single multi-tenant deployment, not one deploy per customer.
2. Customers should retain the ability to author templates for their own workspace
   (only *automatic* generation is excluded).
3. The customer build's entitlement gate behaviour is otherwise unchanged.
