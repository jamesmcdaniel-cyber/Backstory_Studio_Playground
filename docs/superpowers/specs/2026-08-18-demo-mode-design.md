# Demo mode — a disposable, anonymised copy of your workspace

**Date:** 2026-08-18
**Status:** Draft (awaiting design review)

## Problem

Marketing needs to record the product. Every screen that matters is full of
real customer names, real contacts, real email addresses and real logos, so
today the only way to produce a usable capture is to redact frames by hand
afterwards — which is slow, and one missed frame is a customer disclosure in
public material.

A demo session must therefore satisfy four things at once:

1. **Every feature works.** Building a flow, running it, watching the run
   narrate, browsing agents and the dashboard. A read-only tour is not enough;
   the act of building and running is the thing worth capturing.
2. **Nothing real appears anywhere.** Not company names, not people, not
   emails, not logos — and not inside AI-generated prose either, which is where
   field-level redaction always fails.
3. **Nothing persists.** A demo session leaves the real workspace exactly as it
   found it. No half-built demo flows to clean up, no demo runs in the history.
4. **Nothing goes out.** A capture session must not email a real customer or
   post to a real Slack channel through the user's connected accounts.

## Approach

### Rejected: a masking layer at the response boundary

The obvious design is a masker in `withAuthenticatedApi`
(`src/lib/server/api-handler.ts:187`) rewriting tenant data on its way to the
browser. It is feasible here — no `page.tsx` touches Prisma, every surface
reads through `/api`, and the two realtime channels
(`src/components/flows/use-flow-run-stream.ts`,
`src/components/flows/run-panel.tsx:204`) carry a content-free `tick` rather
than data — so there is genuinely one seam to cover.

It still fails requirement 2. A masker can only replace names it already knows
about. During a demo session the model is handed *real* account data and writes
new prose from it; that prose names companies in forms the alias book never
saw ("the Acme renewal", "their Chicago team"). It also fails requirement 4 by
construction, because the run engine still holds live credentials.

### Chosen: a disposable workspace containing only fictional data

Entering demo mode creates a second, real `Organization` and copies the user's
workspace into it, **anonymising as it copies**. The demo org then contains no
real value at all. Everything downstream — API responses, exports, logs, worker
jobs, model prompts — is fictional by construction, with no layer to leak
through and no route to forget.

This inverts the two hard requirements into properties of the sandbox:

- **Nothing persists**, because the sandbox is a separate tenant that gets
  deleted. Enforced by PostgreSQL's tenancy policy, not by developer
  discipline: a route *cannot* write to the real workspace during a demo
  session, because the request's `organizationId` is not the real one.
- **Nothing real appears**, because nothing real was ever copied in. Prose the
  model writes during the session is fictional because its inputs were.

## Design

### 1. The sandbox organisation

New fields on `Organization`:

| Field | Meaning |
|---|---|
| `kind = 'demo'` | Existing discriminator, new member. Excluded from the catalogue, from billing, and from every operator listing that counts real workspaces. |
| `demoOfOrganizationId` | The workspace this is a copy of. |
| `demoOwnerUserId` | The one user who may enter it. |

One demo org per user, not per session. Because sessions live until explicitly
exited, re-entering demo mode **reuses** the existing demo org — same
fictional companies, same run history, same screenshots across a multi-day
shoot. Exiting deletes it.

### 2. Entering, and how the swap works

`requireAuthContext` (`src/lib/server/auth.ts:105`) resolves
`auth.organizationId` from `auth.dbUser.organization`. Demo mode adds one step:
when the demo-session cookie is present *and* names a demo org whose
`demoOwnerUserId` is this user, `auth.organizationId` becomes the demo org id.

The `User` row is never modified — membership, role and permissions are the
user's real ones, carried across unchanged. Everything after that point in the
request (`ambientOrganization.run`, the tenant guard, RLS) is already
org-scoped, so the isolation is inherited rather than built.

Permissions are carried, not elevated: `resolvePermissions` is still called
with the user's real role. The demo org's `kind: 'demo'` must NOT grant the
`internal`/`partner` privileges that `kind` otherwise gates.

### 3. The snapshot, and what it copies

A snapshot pass copies the real workspace into the demo org, rewriting as it
goes. Scope, by intent:

- **Copied in full:** `Flow`, `FlowVersion`, `AgentTask`, `AgentTeammate`,
  `AgentTemplate`, `FlowTemplate`, `AgentConnector`, `Team`, `TeamMember`,
  `User` (see below), `KnowledgeDocument` + `KnowledgeChunk`,
  `SharedSkill`, `Signal`, `SignalSubscription`, `WorkspaceFolder`.

  Colleagues are copied as **shadow members**: anonymised `User` rows in the
  demo org, so teammate pickers and ownership labels render populated. Their
  `supabaseId` is unique-constrained, so each shadow row gets a generated one
  that matches no real identity and therefore can never be authenticated as.
  The acting user is deliberately **not** among them — they remain a member of
  their real workspace and only their request's `organizationId` is redirected.
- **Copied, bounded:** `FlowRun` + `FlowRunStep`, `AgentExecution` +
  `ExecutionMessage`, `AgentChatSession` + `AgentChatMessage`, `Notification`,
  `HuddleSegment` + `HuddleNote` — the most recent N per parent (N = 25), so a
  large workspace does not make entering demo mode slow. History is for looking
  populated, not for completeness.
- **Copied as shells:** `Integration`, `NangoConnection`, `McpConnection`,
  `PeopleAiConnection` — present and rendering as connected so the
  Integrations page looks lived-in, but carrying **no credential**.
  `IntegrationSecret`, `HttpCredential` and `ApiKey` are never copied.
- **Never copied:** `AuditEvent`, `LlmCall`, `OutboxEvent`, `FlowSideEffect`,
  `CatalogueSubmission`, `TemplateProposal`, `ApiAccessToken`, `ScimToken`,
  `IdentityProvider`, `OrganizationDomain`, `Invitation`, `FeatureGrant`,
  `PushSubscription`, `StoredFile`, `FlowWebhookReceipt`.

**Guard test.** A test enumerates every org-scoped model in the Prisma schema
and fails when one is neither in the copy list nor in an explicit exclusion
list with a stated reason. Same shape as the existing secret-surface guard
(`src/lib/flows/__tests__/secret-surface-guard.test.ts`); this is what stops
the design rotting as the schema grows.

### 4. The alias book

Substitution is deterministic: `hash(realOrgId + normalisedValue)` indexes a
fixed dictionary, so the same real company is the same fictional company on
every screen, in every run, and across re-entry.

- **Companies** → a fictional name plus a matching domain
  (`Northwind Traders` / `northwindtraders.com`).
- **People** → a fictional name, title, and an email at their company's
  fictional domain, so `sarah.chen@acme.com` becomes
  `dana.whitfield@northwindtraders.com` rather than a mismatched pair.
- **Phones, addresses, national ids, card numbers, IPs** → generated
  replacements, detected with the patterns already in
  `src/lib/security/pii-egress.ts`. That module deliberately detects without
  transforming, for reasons its header explains and this does not change — the
  detectors are reused; the module keeps its no-transform contract.
- **Free text** (run outputs, agent prose, notes, emails, prompts) → alias-book
  replacement first, then a detector sweep to catch what the book has no entry
  for.
- **Logos and avatars** → a deterministic generated mark (initials on a
  generated ground, as a small data URL, matching the existing `logoUrl`
  convention). Connector brand logos — Salesforce, Slack — are app assets, not
  tenant data, and stay real.

The alias book is a pure module: no DB, no clock, no env, following
`src/lib/catalogue/sanitize.ts`.

### 5. No real outbound

The demo org holds no credentials, so an outbound step has nothing to
authenticate with. Rather than surfacing that as an auth failure, steps that
would leave the system resolve to a **demo transport** returning realistic
canned responses, so a captured run narrates and succeeds like a real one.

Keyed off `organization.kind === 'demo'`, not off the session, so the Fly
worker enforces it too — the worker reads `organizationId` from the job and
never sees the cookie.

### 6. The indicator

A persistent `Demo` chip in the sidebar chrome, with a one-click **hide for
capture** that suppresses it for 60 seconds and then restores it. Visible by
default so nobody works for an hour believing their edits are saving; out of
the frame on demand so it does not have to be cropped out of every shot.

### 7. Exiting

Exiting clears the cookie and calls the existing
`teardownOrganization` (`src/lib/org-teardown.ts`), whose FK cascades already
delete every owned row. Because the demo org has no Nango connections and no
stored files, its external legs are no-ops.

Two safety valves, since sessions have no TTL: the operator console lists demo
orgs with their age, and teardown also runs when the demo org's owner is
deactivated or their real workspace is torn down.

## Testing

- **Isolation:** driving a full demo session (create flow, edit, run) writes
  zero rows to the real workspace.
- **Anonymity:** after a snapshot of a fixture workspace seeded with known real
  names, no demo-org row — including free-text bodies — contains any of them.
- **Stability:** the same real value maps to the same alias across two separate
  snapshots.
- **Outbound:** a demo run of a flow with connector, HTTP and email steps makes
  no external call.
- **Coverage:** the schema guard test described in §3.
- **Permissions:** a demo session does not gain `internal`/`partner`
  privileges from the demo org's `kind`.

## Out of scope

- A seeded synthetic workspace for users with no real data yet. Demo mode
  copies what you have; someone with an empty workspace gets an empty demo.
- Sharing a demo session with another user. One owner, one sandbox.
- Masking anything outside the tenant boundary — help-centre content, the
  catalogue, connector brand assets.

## Related work

- `src/lib/catalogue/sanitize.ts` — snapshot-time hygiene, the closest existing
  pattern.
- `src/lib/security/pii-egress.ts` — the PII detectors reused here.
- `src/lib/org-teardown.ts` — reused verbatim for exit.
- 2026-08-03 customer-edition design — the other `EDITION`/`kind`-gated split.
