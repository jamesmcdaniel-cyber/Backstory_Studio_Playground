# Revocation spine — deprovisioning that actually revokes

**Date:** 2026-08-12
**Status:** Approved (design reviewed 2026-08-12)
**Sub-project:** 1 of 4 in the credential governance program (see *Related work*)

## Problem

Deprovisioning a user is identity-only. Four paths deactivate someone —
`DELETE /api/organizations/members/[id]`, the operator console's
`deactivate` action, SCIM `PATCH active:false`, and SCIM `DELETE` — and all
four do the same two things: set `isActive: false` and ban the Supabase
session. None of them touch a credential.

What survives a suspension today:

- `Integration`, `PeopleAiConnection`, and personal `McpConnection` rows stay
  present and `isActive: true`, holding encrypted OAuth tokens.
- The OAuth grant at Nango is untouched. `client.deleteConnection` is called in
  exactly two places — `src/lib/org-teardown.ts` (whole workspace deleted) and
  `DELETE /api/nango/connections/[integrationId]` (manual disconnect). Neither
  runs on suspension, so the provider-side grant outlives the account
  indefinitely.
- Scheduled flows and agents the person owned keep firing. `attributeOwners` in
  `src/lib/scheduling/owners.ts` skips the inactive named owner and falls back
  to *the org's oldest active member*, so the work continues under an unrelated
  colleague's identity.
- Their `ApiKey` rows keep `revokedAt: null`. These do fail closed in practice —
  `src/lib/public-api/auth.ts:22` re-checks `isActive` — but the rows are never
  marked revoked, so an inventory of live keys reads wrong.

Separately, and independent of suspension: `resolveNangoConnection` in
`src/lib/nango/delivery.ts:133` ends its fallback chain with `candidates[0]`,
an *arbitrary other member's personal connection*. One member's flow can
execute through another member's personal OAuth token. This contradicts the
agents-act-as-user mandate directly.

The revocation logic largely exists already — `src/lib/org-transfer.ts` deletes
`integration`, `peopleAiConnection`, `mcpConnection`, and `pushSubscription`
when a user changes workspace. It was simply never wired to deactivation. That
is the shape of the bug and the reason the fix cannot be "add a call to the four
paths": a fifth path added later reintroduces it silently.

## Goal

Suspension revokes. Specifically:

1. A suspended user's credentials cannot be *used*, no matter which call site
   asks for them, including from a deprovision path nobody has written yet.
2. The OAuth grant is removed at the provider, not merely forgotten locally.
3. Work they owned stops running rather than silently changing owner, and can
   be recovered by an admin in one action.
4. No member can execute through another member's personal credential.

## Non-goals

- The credential inventory UI (sub-project 2).
- Redaction of tenant data reaching model providers (sub-project 3).
- `ENCRYPTION_KEY` rotation and full credential-lifecycle audit coverage
  (sub-project 4). This spec adds only the minimum audit vocabulary its own
  events need.
- Postgres RLS. The invariant here is a guardrail in the same sense the tenant
  guard is one.

## Design

Three layers. Each prevents a different failure, and none is sufficient alone.

### Layer 1 — Resolver invariant (prevents use)

A Prisma client extension ANDs an owner-liveness filter into reads on the four
user-owned credential models:

```
{ OR: [{ userId: null }, { user: { is: { isActive: true } } }] }
```

`userId: null` is preserved as usable because it means org-owned, not
unowned-and-dangerous — an org-shared MCP server or Nango connection belongs to
the workspace and does not die with a person.

**Registry — exactly four models:** `Integration`, `PeopleAiConnection`,
`McpConnection`, `NangoConnection`.

`HttpCredential` and `IntegrationSecret` are deliberately **excluded**: neither
has a `userId` column. They are workspace-owned credentials, and revoking them
when a person leaves would break the org rather than protect it.

`ApiKey` is also excluded from the invariant. It has a `userId`, but it already
fails closed at authentication time; `revokeUserAccess` marks its rows revoked
so inventories read correctly.

**Why an extension and not resolver-by-resolver:** `McpConnection` is loaded
from 12+ call sites (`src/features/agents/tool-planes.ts`,
`src/lib/connectors/agent-connectors.ts`, `src/features/flows/http-auth.ts`,
`src/app/api/flows/import/route.ts`, and others). There is no chokepoint to
patch. An extension covers all of them and every future one.

**Relationship to the tenant guard:** this lives beside `src/lib/tenant-guard.ts`
and follows its registry shape, but inverts its mechanism. `assertOrgScoped`
*throws* on an unscoped query. This extension *rewrites* args, injecting a
filter so the rows become invisible. Rejection would break every legitimate
query; injection is transparent to callers.

**`systemPrisma` bypasses the invariant**, as it bypasses the tenant guard. That
is deliberate and required: the revocation sweeper and
`src/lib/mcp/health-sweep.ts` must see rows in order to clean them up.

### Layer 2 — `revokeUserAccess()` (removes possession)

`src/lib/revoke-user-access.ts`:

```
revokeUserAccess(userId, organizationId, reason): Promise<RevocationResult>
```

In one transaction:

- delete `Integration`, `PeopleAiConnection`, `McpConnection` (user-owned rows
  only), `NangoConnection` (user-owned rows only), and `PushSubscription`
- set `revokedAt` on the user's non-revoked `ApiKey` rows
- stamp `quarantinedAt` on `Flow` and `AgentTask` rows they own
- enqueue one `credential.revoke` outbox event per Nango connection
- write audit rows

`PushSubscription` is deleted here but is not in the Layer 1 registry: it holds
a device endpoint rather than a resolvable credential, so it needs cleanup but
not invisibility.

`src/lib/org-transfer.ts` becomes a caller rather than a parallel
implementation, so there is one revocation path rather than two that drift.

**Called by all four deprovision paths.** Layer 1 is what makes a *missed* call
site degrade to "unusable but not yet revoked upstream" instead of a live hole.

### Layer 3 — Upstream revoke, outbox-retried (removes the grant)

New outbox topic `credential.revoke`, drained where `flow.signal` already
drains (`src/lib/scheduling/dispatch-tick.ts`, `src/lib/workers/runtime.ts`),
reusing the existing backoff and `MAX_ATTEMPTS = 8`.

Suspension commits locally and never blocks on Nango. An admin suspending a
hostile user must not be stoppable by a vendor outage — the opposite coupling
(`org-teardown.ts`, which rolls back on external failure) is correct for
"prove the data is gone" and wrong for "stop this person now".

### Two fixes the invariant does not cover

**`candidates[0]` (`src/lib/nango/delivery.ts:133`).** The invariant narrows
this fallback to active users; it does not stop cross-user borrowing. The chain
becomes `own ?? org-level`, returning `null` otherwise, so the run surfaces
"connect your account" rather than silently executing as a colleague.

**`attributeOwners` (`src/lib/scheduling/owners.ts`).** The oldest-active-member
fallback is *correct* for genuinely shared rows (`userId === null`) and wrong
only when `userId` is set but that person is inactive. Only the second case
changes — such candidates are absent from the returned map, which callers
already skip. Removing the fallback wholesale would break every shared agent in
the product.

## Quarantine and claim

One nullable `quarantinedAt` column on `Flow` and `AgentTask`, so quarantine is
distinguishable from a human disabling something. Without the marker the two
are indistinguishable and the queue cannot be built.

**`quarantinedAt` is the single source of truth, and no status column is
mutated.** Dispatch skips any row with it set, and the flows UI reads it as
not-runnable. The tempting alternative — setting `Flow.status = 'DISABLED'` —
destroys the prior value, so a claim has nothing to restore and every
quarantined draft would come back as active. Keeping quarantine orthogonal to
status avoids that entirely.

The claim queue is **derived** — rows with `quarantinedAt IS NOT NULL` — so
there is no new model. Claiming rebinds `userId` to the claimer, clears
`quarantinedAt`, and writes an audit row. Work resumes under the claimer's
identity and the claimer's credentials, at whatever status it already had.

This is the answer to "CS depends on this, we can't just turn it off": the
outage is real but visible and one click from repair, rather than silent.

## Error handling

On outbox exhaustion the event remains as a `failed` row whose payload carries
`providerConfigKey` and `connectionId`. **That row is the record that a grant is
still live upstream** — queryable as an unresolved list, requiring no new model.
A `credential.revoke_failed` audit row makes it visible rather than silent.

Audit writes follow the existing rule in `src/lib/audit.ts`: failures are
swallowed and reported, never allowed to break the action they record.

## Consequence: reactivation does not restore access

Because the upstream grant is deleted, reactivating a user does not give their
integrations back — they must reconnect each provider. This is inherent to
revoking at the provider rather than locally, and is the correct behavior, but
it will read as a bug to anyone who does not expect it. The reactivate path
should say so plainly in its response, and the operator console should state it
at the point of action.

## Audit vocabulary added

The audit log currently records flow, approval, catalogue, and platform events
and has no credential vocabulary at all. Note also that
`DELETE /api/organizations/members/[id]` writes **no audit row today** —
removing someone from a workspace currently leaves no trace. This spec adds:

- `member.deprovisioned` — with the reason and the deprovision path
- `credential.revoked` — per credential, with provider and scope
- `credential.revoke_failed` — on outbox exhaustion
- `work.quarantined` / `work.claimed` — with resource type and id

Broader lifecycle coverage (grant, read, rotate) belongs to sub-project 4.

## Testing

- **Registry guard test** walking the DMMF: fails when a model gains a `userId`
  plus a credential shape without joining the registry. Mirrors the existing
  export-denylist guard test.
- **`findUnique` guard test** — see the gotcha below; fails if a registered
  model is read via `findUnique` at a site the extension cannot filter.
- One test per deprovision path, asserting credentials are gone, API keys
  revoked, owned work quarantined, and outbox events enqueued.
- One invisibility test per registered model: a row owned by an inactive user is
  not returned through `prisma`, and *is* returned through `systemPrisma`.
- A test pinning the `candidates[0]` removal — a member with no connection of
  their own resolves `null`, not a colleague's token.
- A scheduler test asserting both halves: an inactive explicit owner is absent
  from the map, and a `userId: null` row still falls back to the oldest active
  member.
- An outbox-exhaustion test asserting the `failed` row retains the payload
  needed to identify the un-revoked grant.

## Implementation gotcha

`findUnique` accepts only unique fields in `where`, so the filter cannot be
injected there. `src/lib/peopleai/client.ts:123` is exactly this case — it reads
`peopleAiConnection.findUnique`, which is where the People.ai OAuth tokens live.
Those sites must be rewritten to `findFirst` or post-filtered.

The `findUnique` guard test above exists specifically for this: without it, the
invariant has a silent hole in the highest-value place.

## Related work

Sub-projects 2–4 of the governance program, each getting its own spec:

2. **Credential inventory** — the "who has access to what" surface. Depends on
   this spec for the revoke action.
3. **AI egress controls** — a redaction boundary in front of
   `src/lib/llm/model-runner.ts`. No redaction layer exists anywhere in `src`
   today. Independent of this spec.
4. **Key rotation + credential audit** — key-id in the `v1:` ciphertext format
   so `ENCRYPTION_KEY` can rotate, plus full lifecycle audit coverage. Depends
   on the vocabulary this spec establishes.
