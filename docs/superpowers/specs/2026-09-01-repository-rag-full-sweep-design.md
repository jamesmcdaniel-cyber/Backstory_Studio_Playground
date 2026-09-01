# Repository (RAG) full sweep — design

**Date:** 2026-09-01
**Status:** approved for planning
**Origin:** Andrew asked for "a place to upload and store enablement materials — customer journey documents — so agents reference them instead of us writing all the context into each agent or skill's markdown."

## 1. Context

The capability Andrew described already exists and runs in production. It is the
**Repository** (`/data-tables`, Files view). This spec does not build it; it
closes the six gaps between "supported" and "an agent can actually use a
60-page customer journey document."

### Baseline — what ships today

| Layer | Implementation |
|---|---|
| Ingest | `src/lib/knowledge/ingest.ts`, `extract.ts`, `docx.ts` — PDF (unpdf), DOCX (own WordprocessingML reader), md/txt/csv/tsv/json/yaml/xml/html and common source. 10 MB (`STORED_FILE_MAX_BYTES`), 200k chars, 200 chunks. |
| Chunking | 1200 chars, 150 overlap, paragraph/sentence-boundary aware. |
| Embeddings | Voyage `voyage-3`, 1024-dim, 7-day cache (`src/lib/rag/embeddings.ts`). `VOYAGE_API_KEY` is set in Vercel Production and Preview. |
| Retrieval | `src/lib/knowledge/retrieve.ts` — pgvector `<=>` cosine over an HNSW index, `hnsw.iterative_scan = relaxed_order`, `SET LOCAL search_path = public, extensions`, org-scoped raw SQL inside `tenantTransaction`. Keyword fallback when the query cannot be embedded. |
| Sources | Upload, read-only integration pulls (Nango + Granola, `pull.ts`), GitHub sync with disappeared-file reconciliation (`github-sync.ts`), editable Markdown "projects". |
| Governance | Per-agent or org scope, enable/disable, `version` with optimistic concurrency and a stale-processing lease, audit rows, original bytes retained in `StoredFile` and downloadable. |
| Runtime | `src/features/agents/execute-agent.ts:1186` injects up to 5 passages into the system prompt and records a `knowledge.retrieved` event. Flows get a `knowledge` step (`run-action-step.ts:569`). |
| Eval | `npm run eval:rag` — golden set, judge, nightly workflow. |

### The six gaps

1. **Agents cannot look anything up.** Retrieval is one-shot and pre-run: a
   single query built from `objective + input`, top-5 chunks (~6 KB), injected
   once. No agent-callable search tool exists in any tool plane. For a long
   document this is the difference between "the agent has the document" and
   "the agent got five paragraphs that happened to match its objective."
2. **Silently dead documents.** `embeddingsFor` (`ingest.ts:31-38`) swallows
   embedding failures and writes chunks with `embeddingVec = NULL`. The vector
   path excludes NULL rows; the keyword fallback only fires when *the query*
   cannot be embedded. Those chunks are therefore invisible to **both** paths,
   permanently, while the UI shows `ready · N passages`. One transient Voyage
   429 during an upload produces a document that will never be retrieved and
   never says so. Recorded at `ARCHITECTURE.md:61`.
3. **No real citations.** `renderKnowledge` asks the model to name the file. No
   `documentId` or link reaches the answer and nothing verifies it.
4. **Flow step is mis-scoped.** `run-action-step.ts:569` passes `agentId: ''`,
   so the step only ever sees org-wide documents, and applies no relevance floor.
5. **Not exposed over MCP.** `/api/mcp` serves data tables but no repository
   search, so Claude and the People.ai delivery surface cannot reach enablement
   material at all.
6. **Flat library, binary scoping.** Org-wide or exactly one agent. No
   collections or tags — "attach the Customer Journey set to these four agents"
   is not expressible, which is precisely the shape of an enablement library.

## 2. Goals and non-goals

**Goals**
- An agent can search, list and read repository documents on demand, mid-run.
- A document that fails to embed remains findable and says so.
- Answers carry a stable, clickable citation back to the source document.
- Documents organize into collections that attach to many agents at once.
- The same tool set serves agents and external MCP callers.
- Flow knowledge steps can target the same scopes agents can.

**Non-goals**
- Re-ranking models, hybrid BM25 indexes, or query rewriting. The relevance
  floor plus the eval harness stay the quality instrument.
- Raising the 10 MB / 200k char ceilings. WS6 makes truncation honest, not larger.
- Image, audio or spreadsheet-cell extraction. Formats stay as they are.
- Per-chunk ACLs. The tenancy unit remains the document.

## 3. Design

### WS1 — Repository tool set (the spine)

New `src/lib/knowledge/tools.ts`, modelled directly on `src/lib/data-tables/tools.ts`:
`REPOSITORY_TOOLS` (descriptors) plus `RepositoryToolClient implements McpToolClient`,
constructed with `(organizationId, userId, agentId?)`.

| Tool | Input | Output |
|---|---|---|
| `repository_search` | `query` (required), `collection?`, `documentId?`, `topK?` 1-20 default 8 | passages with `documentId`, `filename`, `collection`, `score`, `matchedBy: 'vector' \| 'keyword'` |
| `repository_read` | `documentId` (required), `offset?` default 0, `limit?` default 8000 chars, max 20000 | `filename`, `collection`, `totalChars`, `offset`, `nextOffset`, `text` |
| `repository_list` | `collection?`, `search?` | documents (`id`, `filename`, `description`, `collections`, `charCount`, `indexState`) and the collection list |

`repository_read` is the piece that makes a long document usable: `nextOffset`
lets an agent walk a customer journey doc end to end instead of sampling it.

Every tool is `isWrite: false` — no approval gate, and a guard test pins that.

Registered in two places from one definition:
- **Agents.** A new `ConnectorDescriptor` in `src/lib/connectors/registry.ts`
  (`providerId: 'repository'`, `kind: 'builtin'`, `isWrite: false`,
  `available: () => true`), and a group in `loadNativePlaneGroups`
  (`src/features/agents/tool-planes.ts`) at `backstory://repository`, following
  the Data Tables block at line 433.
- **MCP.** Descriptors appended to `MCP_MANAGEMENT_TOOLS`
  (`src/lib/mcp/server/tools.ts`) and `tools/call` cases in
  `src/app/api/mcp/route.ts`, alongside the existing `data_table_*` cases.

**Scoping differs by surface, deliberately.** An agent's client passes its
`agentId`, so it sees org-wide documents, its own, and its collections. An MCP
caller has no agent identity, so it searches org-wide documents plus every
collection visible to the authenticated user, reusing the visibility predicate
already in `listRepositoryAssets` (`repository.ts`: `agentId IS NULL OR agentId
IN visibleAgents OR userId = caller`).

### WS2 — Collections

Three additive models. `KnowledgeDocument.agentId` is retained unchanged, so
every existing attachment keeps working.

```prisma
model KnowledgeCollection {
  id             String   @id @default(cuid())
  organizationId String   @db.Uuid
  name           String
  description    String   @default("") @db.Text
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  organization Organization                   @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  documents    KnowledgeDocumentCollection[]
  agents       AgentKnowledgeCollection[]

  @@unique([organizationId, name])
  @@index([organizationId, updatedAt])
  @@map("knowledge_collections")
}

model KnowledgeDocumentCollection {
  documentId     String
  collectionId   String
  organizationId String @db.Uuid

  document   KnowledgeDocument   @relation(fields: [documentId], references: [id], onDelete: Cascade)
  collection KnowledgeCollection @relation(fields: [collectionId], references: [id], onDelete: Cascade)

  @@id([documentId, collectionId])
  @@index([organizationId, collectionId])
  @@map("knowledge_document_collections")
}

model AgentKnowledgeCollection {
  agentId        String
  collectionId   String
  organizationId String @db.Uuid

  agent      AgentTask           @relation(fields: [agentId], references: [id], onDelete: Cascade)
  collection KnowledgeCollection @relation(fields: [collectionId], references: [id], onDelete: Cascade)

  @@id([agentId, collectionId])
  @@index([organizationId, agentId])
  @@map("agent_knowledge_collections")
}
```

Three back-relations come with them: `KnowledgeCollection[]` and
`AgentKnowledgeCollection[]` on `Organization`, `collections
KnowledgeDocumentCollection[]` on `KnowledgeDocument`, and `knowledgeCollections
AgentKnowledgeCollection[]` on `AgentTask`.

All three carry `organizationId` so they take the standard tenant policy. The
migration must replicate the block from
`prisma/migrations/20260827160000_rls_flow_reviews_audit_streams/migration.sql`
verbatim for the three new tables: `ENABLE` + `FORCE ROW LEVEL SECURITY`, the
`tenant_isolation` policy on `app.organization_id`, `GRANT` to `backstory_app`
when that role exists, `REVOKE ALL` from `anon` and `authenticated`.

The retrieval predicate in `retrieveKnowledge` widens from
`(d."agentId" = $agent OR d."agentId" IS NULL)` to:

```sql
AND (
  d."agentId" = ${agentId}
  OR d."agentId" IS NULL
  OR d."id" IN (
    SELECT dc."documentId"
      FROM "knowledge_document_collections" dc
      JOIN "agent_knowledge_collections" ac ON ac."collectionId" = dc."collectionId"
     WHERE ac."agentId" = ${agentId}
       AND ac."organizationId" = ${organizationId}::uuid
  )
)
```

The predicate is built once in a shared helper so the vector path, the keyword
path and the Prisma fallback cannot drift apart.

UI: a Collection column and filter in `content-repository.tsx`, a collection
picker in the upload/edit/project dialogs, and an "Attached collections"
control on the agent page extending `src/app/agents/knowledge-panel.tsx`. New
routes `/api/repository/collections` (list, create, rename, delete) and
`/api/agents/[id]/collections` (attach, detach).

### WS3 — Indexing trust (built first)

Three parts, in order of importance.

**(a) The correctness fix — per-document fallback.** Today the keyword path is
an alternative to the vector path, chosen per *query*. It becomes a supplement
chosen per *document*: the vector query runs over embedded chunks as it does
now, and a bounded keyword pass runs over chunks belonging to documents whose
`indexState <> 'indexed'`. Merge rule, so ranking stays honest across two
incomparable score scales: vector hits fill the result set first; keyword hits
are admitted only to fill remaining slots, only at `keywordScore >= 0.5`
(half the query's distinct terms present), and never displace a vector hit that
cleared the relevance floor. `KnowledgeHit` gains `matchedBy: 'vector' |
'keyword'` so the run log and the tool output can say which it was.
An unindexed document becomes degraded rather than invisible.

**(b) Honest state.** `KnowledgeDocument.indexState String @default("pending")`
— `indexed | partial | unindexed | pending` — derived after `writeVectorColumns`
from the count of `embeddingVec IS NULL` chunks, plus `indexError String?`
carrying the provider failure reason. `embeddingsFor` stops discarding the
error: it still degrades rather than failing the upload, but the reason is
persisted. The repository table renders an "Unindexed — retry" badge with a
manual re-index action; the agent's knowledge panel shows the same state.

**(c) The sweep.** `scripts/reembed-backfill.ts` already contains a resumable,
keyset-paginated batch loop with a `knowledgeChunkAdapter` and unit-tested pure
decision logic. Extract that into `src/lib/knowledge/reembed-sweep.ts`,
mirroring `src/lib/activity/indexer-sweep.ts`, and have both the script and a
new cron route call it. New `/api/cron/reembed-sweep` copies the `CRON_SECRET`
auth from `src/app/api/cron/indexer-sweep/route.ts` verbatim (`timingSafeEqual`,
`recordTokenRejection`, 503 when unset), and `vercel.json` gains
`{"path": "/api/cron/reembed-sweep", "schedule": "*/10 * * * *"}`. The sweep
recomputes `indexState` for each document it touches.

### WS4 — Citations

`retrieveKnowledge` already returns `documentId`; it just never leaves the
module. Thread it through:
- `renderKnowledge` and every tool result emit a stable handle,
  `[doc:<id> "<filename>"]`, and the prompt instructs the model to carry it.
- The `knowledge.retrieved` event payload gains `documents: [{id, filename}]`
  (see the run-time section for where that event is now emitted from).
- The run panel renders each cited document as a link to
  `/data-tables?doc=<id>`, and the repository page opens that document's editor
  when the query parameter is present.

Citation is not enforced — that is prompt quality, not plumbing. What this
guarantees is that the handle exists and resolves.

### WS5 — Flow knowledge step

The `knowledge` node config gains `scope` (`{ agentId?: string; collectionId?:
string }`) and `minScore?`. `run-action-step.ts` passes the real scope through
the shared predicate helper instead of `agentId: ''`, and applies
`KNOWLEDGE_RELEVANCE_FLOOR` by default with an explicit override. The builder
gets a plain-English scope picker — a dropdown of agents and collections, no
raw identifiers or token syntax in the UI.

Back-compat: a node with no `scope` keeps today's org-wide behavior, so saved
flows do not change meaning.

### WS6 — Truncation honesty

`KnowledgeDocument.truncated Boolean @default(false)`, set in
`normalizedContent`/`replaceKnowledgeDocumentContent` when the extracted text
exceeded `KNOWLEDGE_MAX_CHARS` or the chunk list hit `KNOWLEDGE_MAX_CHUNKS`.
Surfaced as a badge with the indexed-vs-original character counts, so a user
who uploads a 400-page PDF learns that half of it is not indexed instead of
discovering it through a bad answer.

### Run-time behavior change

The block at `execute-agent.ts:1186` no longer injects passages. It renders a
bounded manifest of the documents and collections available to this agent —
at most 25 entries and 1500 characters, whichever binds first, ordered by
collection then by most recently updated:

```
## Repository available to you
- "FY26 Customer Journey" — stage map, exit criteria (Customer Journey)
- "Discovery Playbook" — MEDDPICC question bank (Enablement)
…and 14 more. Call repository_list to see them.
Call repository_search for passages, repository_read to open a document.
```

Titles and descriptions only; passages arrive when the agent asks. The agent
knows the customer journey document exists, so it knows to open it, and
unrelated runs stop paying for five irrelevant passages.

`knowledge.retrieved` is no longer emitted at prompt-build time. It is emitted
once per `repository_search` / `repository_read` call, recording what was
actually retrieved and its citation handles. A new `knowledge.available` event
at prompt-build time records the manifest the agent was offered, so the run log
still answers both "did it know the document was there?" and "did it open it?"

## 4. Testing

**Unit (`node:test`)**
- Tool descriptor schemas and `RepositoryToolClient` dispatch, including
  `repository_read` offset/`nextOffset` paging across a document boundary.
- The shared scope-predicate builder for all three call sites.
- `indexState` derivation from NULL-vector chunk counts.
- The vector/keyword merge rule: keyword hits never displace an above-floor
  vector hit, and are dropped below the overlap threshold.
- Citation handle rendering and manifest truncation with the overflow line.

**Database (`*.db.test.ts`, seeded pgvector — existing convention)**
- Collection-scoped retrieval returns documents attached via collection, via
  `agentId`, and org-wide, and never returns another org's rows. This is the
  load-bearing assertion.
- A document with NULL vectors is reachable by keyword and reports
  `matchedBy: 'keyword'`.
- The re-embed sweep fills NULL vectors in bounded batches, is re-runnable, and
  recomputes `indexState`.
- Collection delete detaches without deleting documents; document delete
  removes join rows.

**Guards**
- Every `repository_*` tool is `isWrite: false` in both the native plane and
  the MCP tool list, and the two lists agree.
- The route-coverage test picks up the new cron and collection routes and
  requires their auth declarations.
- Tenant-isolation guard extended over the three new tables.

**Eval**
- `npm run eval:rag` before and after the manifest change. The index-card switch
  is the one behavioral regression risk in this spec, and the golden set is the
  instrument that measures it. Record both scorecards in the PR.

## 5. Rollout

- All schema changes are additive; no column is dropped and no default changes
  for existing rows. `indexState` backfills to `pending` and the first sweep
  resolves it.
- Migrations ship via `prisma migrate deploy` (baselined).
- The Fly worker must be `fly deploy`ed after the tool change — a worker running
  the old runtime would not know the repository tools exist.
- `VOYAGE_API_KEY` is already present in Production and Preview; no new
  environment variable is introduced.
- The customer edition (`Backstory_customers`) mirror: these are end-user
  surfaces, not operator surfaces, so no gating is required — but the new cron
  route is operational and must not leak into the customer config.

## 6. Build order and risks

**Order:** WS3 → WS1 → WS2 → WS4 → WS5 → WS6. Correctness before surface area:
shipping agent tools on top of silently unindexed documents would make the bug
harder to see, not easier.

| Risk | Mitigation |
|---|---|
| Dropping blind injection changes behavior for every existing agent | The manifest keeps the repository discoverable; `eval:rag` gives a before/after number; the change is one function and reversible. |
| Two score scales merged in one result set | Vector-first merge rule with a keyword admission threshold, unit-tested, and `matchedBy` on every hit. |
| Migration touches a hot table | Additive only; new tables carry their own RLS policies from the same migration. |
| Repository content newly reachable over MCP | Reuses the existing per-user visibility predicate; org-scoped auth unchanged; tenant-isolation test extended to the MCP path. |
| `repository_read` used to exfiltrate a whole document in one call | Bounded `limit`, explicit paging, and the existing `aiEgressPolicy` guard at the model-call boundary. |
