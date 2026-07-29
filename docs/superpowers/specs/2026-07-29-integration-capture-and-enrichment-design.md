# Integration Data Capture and Graph Enrichment

**Date:** 2026-07-29
**Status:** Approved (design)
**Owner:** James McDaniel

## Problem

The platform can see across CRM, email, and call transcripts, because those are
what People.ai Sales AI ingests. It cannot see the systems where the rest of the
account's story actually happens — the open Zendesk escalation, the blocking
Jira bug, the Linear issue a customer is waiting on.

Workspaces already connect those systems: `NANGO_PROVIDER_TOOLS`
(`src/lib/nango/provider-tools.ts`) exposes 55 tools across 16 providers, and
agents and flows call them during ordinary runs. Every one of those calls
returns real customer data that the platform reads once, hands to a model, and
throws away.

What survives a run today is thin and unstructured:

- `WorkflowStep.output` / `FlowRunStep.output` — the raw response, kept per run
  for debugging. Never correlated to an account, never read again.
- `AuditEvent` — provider and tool name, with the payload deliberately **hashed**
  rather than stored (`src/lib/audit.ts`).
- Graph-RAG — `indexExecution` (`src/lib/rag/indexer.ts`) writes ONE `run` node
  whose text is a 1500-character summary of the run output plus a joined list of
  tool names. The tool results themselves are never entity-resolved.

So a Zendesk escalation surfaced during a run leaves behind a truncated string
on a run node. Ask the assistant "what's blocking the Acme renewal?" and nothing
connects that escalation to the Acme account.

## Goals

- Capture structured facts from external tool calls as they happen, without
  changing how agents or flows execute.
- Resolve those facts to the accounts, opportunities, and stakeholders the graph
  already models, so retrieval can correlate across them.
- Keep the data minimal and revocable: extracted facts only, off by default,
  deletable, and time-bounded.
- Leave a working seam for pushing enriched facts back to People.ai Sales AI.

## Non-goals

- Storing raw third-party payloads. Extraction happens in the same tick and the
  response is discarded.
- Capture on write tools. A write's response is a confirmation, not data.
- Background polling or bulk sync of connected systems. Capture is a side effect
  of work the user already asked for — nothing new is fetched.
- Building the People.ai ingest integration. The endpoint is unknown (see
  Open questions); this spec ships the seam, not the wiring.

---

## 1. Where capture taps

The two engines reach external tools by different routes, both constructed in
`src/features/agents/tool-planes.ts`:

- **Flows** — `resolveFlowToolExecutor` returns `{ provider, isWrite, execute }`;
  `execute-flow.ts` and `poll-dispatch.ts` call `executor.execute(...)`.
- **Agents** — `loadTools` builds bindings carrying a `client.executeTool(...)`,
  which the run loop calls at `execute-agent.ts:1073`.

> **Corrected during planning.** The two are *not* both constructed in
> `tool-planes.ts` — agent bindings are materialized in
> `execute-agent.ts:178`. More decisively, `runId`, which §2 requires for
> provenance, exists only inside the run loop and is not in scope at
> construction. So capture is an explicit fire-and-forget
> `captureToolResult(...)` call at the two run-loop sites, which have full
> context, rather than a constructor decorator. The contract below is unchanged.

The capture call:

- returns the tool result **unchanged** — it is transparent to the caller;
- runs only when `isWrite === false` and the provider is enabled for the org;
- never throws into the run. A capture or extraction failure is logged and
  swallowed, matching how `indexExecution` already behaves on the same hot path.

## 2. What gets stored

```prisma
/// One structured fact extracted from an external tool response. The response
/// itself is NOT retained — extraction happens in the same tick and the payload
/// is discarded, keeping this consistent with AuditEvent hashing its payloads.
model CapturedFact {
  id             String    @id @default(cuid())
  organizationId String    @db.Uuid
  /// Nango provider key, e.g. 'jira' | 'zendesk' | 'linear'.
  provider       String
  /// The tool that produced it, e.g. 'jira_list_issues'.
  tool           String
  /// Extractor-defined shape, e.g. 'issue' | 'ticket'.
  kind           String
  /// Stable id in the SOURCE system (issue key, ticket id) — dedupes re-capture
  /// of the same record across runs.
  externalId     String
  /// Human-readable text; this is what gets embedded.
  text           String    @db.Text
  /// Typed attributes: status, priority, assignee, url, updatedAt.
  props          Json      @default("{}")
  /// Resolution result (§3). Null when nothing resolved — deliberately unlinked.
  accountId      String?
  opportunityId  String?
  /// Provenance: the run during which this was observed.
  runId          String?
  capturedAt     DateTime  @default(now()) @db.Timestamptz(6)
  expiresAt      DateTime  @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@unique([organizationId, provider, externalId])
  @@index([organizationId, capturedAt])
  @@index([organizationId, accountId])
  @@map("captured_facts")
}
```

**Postgres first, graph second.** Graph-RAG indexing is gated on embeddings being
configured and no-ops when `VOYAGE_API_KEY` is unset (`src/lib/rag/get-store.ts`,
`ragEnabled`). A graph-only design would therefore capture *nothing* in any
environment without embeddings, silently. Landing facts in Postgres also makes
them deletable on request and re-indexable when extraction improves — neither of
which an embedded blob supports.

The `@@unique([organizationId, provider, externalId])` means re-observing the
same Jira issue across ten runs updates one row rather than accumulating ten.

## 3. Entity resolution

A captured ticket is worthless until it hangs off an account. Three strategies,
tried **most deterministic first**:

1. **Run context.** The triggering signal already carries `accountId` /
   `opportunityId` — `indexExecution` reads exactly this today
   (`indexer.ts`, `execution.input.signal`). Free, exact, and covers the case
   that matters most: a run started *because* of an account.
2. **Explicit CRM id** found in the extracted props → the existing People.ai
   `find_record_by_crm_id` tool (`src/lib/peopleai/salesai-facts.ts`).
3. **Account-name match** on an organisation/company field → the existing
   `find_account` tool.

If none resolve, the fact is stored with `accountId` null — **unlinked, not
guessed**. A wrong edge silently poisons retrieval for that account, which is
worse than a missing one: the fact simply doesn't surface, rather than surfacing
against the wrong customer. Unlinked facts remain useful — a later run with
better context can resolve them, since the row is keyed by `externalId`.

Strategies 2 and 3 cost a People.ai round-trip, so they run only when strategy 1
misses, and their results are cached on the row.

## 4. Graph enrichment

Resolved facts index into the existing graph-RAG store alongside signals and
runs:

- A new `NodeType` value `'fact'`, added to the union in `src/lib/rag/store.ts`.
  **Confirmed during planning:** both stores are generic over `NodeType` —
  `neo4j-store.ts` casts (`p.type as NodeType`) with no exhaustive switch, so a
  new member breaks nothing.
- A new `EdgeRelation` value `'captured_in'` linking a fact to the run that
  observed it, for provenance.
- Account and opportunity linkage reuses the existing `about_account` and
  `about_opportunity` relations, so retrieval and `expand` need no changes.

Facts inherit the store's existing visibility contract (`nodeVisibleTo`). They
are written `shared` — a Jira ticket is workspace data, not one rep's private
note.

Critically, indexing does **not** write bare account nodes. `upsertNodes` is a
full replace, so a bare node would clobber the richer shared entity node written
by `enrichEntities`. The edge links to the existing entity, which is a no-op when
that entity is not yet indexed — the same discipline `indexCustomSignalResult`
already documents.

## 5. Consent and retention

```prisma
model Organization {
  /// Capture is OFF until a workspace admin turns it on. No third-party data is
  /// stored on anyone's behalf by default.
  captureEnabled   Boolean  @default(false)
  /// Nango provider keys capture is permitted for, e.g. ['jira','zendesk'].
  /// Empty means none, even when captureEnabled is true.
  captureProviders String[] @default([])
}
```

Both are managed on the Integrations settings surface, gated on the
`integration.manage` permission from the RBAC work
(`2026-07-29-rbac-and-catalogue-publishing-design.md`).

The wrapper reads consent **fresh on every capture, uncached**. A cache would
mean a workspace that revokes consent keeps having data captured until the TTL
expires, which is the one behavior this setting exists to prevent. The cost is
one primary-key read against `organizations` on a path that is already making a
network call to a third-party API — negligible next to what it guards.

`expiresAt` is set at capture time from `CAPTURE_RETENTION_DAYS` (default 90).
The existing `cron/retention` route grows a fourth sweep, following the batched
pattern already there (delete in bounded chunks so a backlog drains over
successive runs rather than in one long transaction).

Turning capture off stops new capture; it does not retroactively delete. A
separate "Delete captured data" action on the same settings surface, behind the
same permission and a typed confirmation, removes the org's rows and their graph
nodes. Deletion is a deliberate act rather than a side effect of toggling a
setting — an admin flipping capture off to stop collection should not silently
destroy the enrichment their workspace already relies on.

## 6. Extractors

One module per provider, pure and independently testable:

```ts
extract(tool: string, response: unknown): ExtractedFact[]
```

Three to start, one per provider's single read tool:

| Provider | Tool | Fact kind | Carries |
| --- | --- | --- | --- |
| Jira | `jira_list_issues` | `issue` | key, summary, status, priority, assignee, updated, url |
| Zendesk | `zendesk_list_tickets` | `ticket` | id, subject, status, priority, requester, updated, url |
| Linear | `linear_list_issues` | `issue` | identifier, title, state, priority, assignee, updated, url |

These three were chosen because support and delivery escalations are exactly the
signal CRM, email, and transcripts miss. Each provider exposes exactly one read
tool today, so the extraction surface is genuinely three functions — the registry
shape is what makes adding a fourth cheap, not a reason to build sixteen now.

An extractor that throws is caught by the wrapper and drops that capture; it
never fails the run that triggered it.

## 7. The outbound seam

```ts
interface FactSink {
  emit(facts: CapturedFact[]): Promise<void>
}
```

Two implementations:

- **`GraphRagSink`** — ships now; §4.
- **`PeopleAiSink`** — base URL, resource path, and auth all read from
  configuration; **inert until configured**. It mirrors
  `src/lib/peopleai/register-webhook.ts`, which already documents itself as a
  contract seam against the SalesAI API & Developer Guide and uses the same
  `PAI-Client-Id` / `PAI-Client-Secret` service-key auth against
  `api.people.ai/v1/salesai/*`.

This is what keeps the unknown endpoint (below) from blocking the build: wiring
it later is an implementation of one interface plus configuration, not a
redesign.

## 8. Open questions

**Which People.ai endpoint receives enriched facts.** Unresolved. The only
endpoint present anywhere in this codebase or its history is
`POST /v1/salesai/webhooks`; `mcp.people.ai` exposes eight tools, all reads, and
the People.ai plane is hard-coded `isWrite: false`
(`tool-planes.ts:503`). Resolving it needs either the relevant section of the
SalesAI API & Developer Guide, or a `tools/list` enumeration against
`mcp.people.ai` with live credentials to reveal any ingest tool added since.

Until then `PeopleAiSink` stays inert. **Nothing else in this spec depends on the
answer.**

## 9. Error handling

- Capture failure (extraction throws, DB write fails) → logged, swallowed, run
  unaffected. Capture is never load-bearing for a user's work.
- Resolution failure (People.ai unreachable) → fact stored unlinked. It is not
  retried inline; a later observation of the same `externalId` can resolve it.
- Graph indexing failure → already best-effort and swallowed by `commitGraph`.
- Capture disabled mid-run → the wrapper reads consent uncached per capture, so
  revocation takes effect on the very next tool call, not at the next run.

## 10. Testing

- **Unit** — each extractor against a recorded provider response, including a
  malformed one that must yield `[]` rather than throw. The resolution ladder
  across all four outcomes: run context hit, CRM id hit, name hit, and nothing
  resolved → unlinked.
- **Wrapper** — a throwing extractor does not fail the tool call, and the tool
  result is returned byte-identical with capture on and off.
- **DB** — capture disabled writes zero rows; enabled-but-provider-not-allowed
  writes zero rows; re-observing the same `externalId` updates rather than
  duplicates; the retention sweep deletes only past `expiresAt`.
- **Consent** — a member without `integration.manage` cannot change either
  capture setting or trigger deletion; revoking consent stops the next capture
  without a restart, proving the read is uncached.

## 11. Build sequence

1. Schema: `CapturedFact`, the two `Organization` columns, tenant-guard
   registration, migration.
2. Extractor registry plus the three extractors — pure, no wiring.
3. The resolution ladder — pure over an injected People.ai client.
4. `withCapture` wrapper applied at both construction sites in `tool-planes.ts`.
5. Consent UI on Integrations settings, plus the delete-captured-data action.
6. Graph indexing (`'fact'` node type, `'captured_in'` relation) and
   `GraphRagSink`.
7. Retention sweep in `cron/retention`.
8. `FactSink` interface and the inert `PeopleAiSink`.

Steps 1–4 are independently shippable and produce captured, queryable facts in
Postgres before any graph or outbound work exists.
