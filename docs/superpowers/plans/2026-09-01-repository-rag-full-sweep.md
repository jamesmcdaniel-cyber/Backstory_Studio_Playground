# Repository RAG Full Sweep — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing Repository from a one-shot prompt-stuffer into a repository agents genuinely use — searchable and readable on demand, organized into collections, honest about what is indexed, and citable.

**Architecture:** One shared scope predicate feeds three retrieval call sites. One tool-definition module feeds two surfaces (the agent native plane and the MCP server). Indexing state becomes an explicit column with a per-document keyword fallback, so a document that fails to embed degrades instead of disappearing.

**Tech Stack:** Next.js App Router, Prisma + Postgres (pgvector/HNSW), Voyage `voyage-3` embeddings, `node:test`, Vercel Cron.

**Spec:** `docs/superpowers/specs/2026-09-01-repository-rag-full-sweep-design.md`

## Global Constraints

- Embedding dimension is exactly **1024** (`EMBEDDING_DIM`). Every `::vector(1024)` cast stays as-is.
- Every raw SQL statement touching `embeddingVec` must run inside a transaction that first executes `SET LOCAL search_path = public, extensions` — Supabase installs pgvector into `extensions`.
- Tenant-scoped reads/writes go through `prisma` + `tenantTransaction`. Cross-org maintenance sweeps use `systemPrisma` and must say why in a comment.
- Every new tenant table gets `ENABLE` + `FORCE ROW LEVEL SECURITY`, a `tenant_isolation` policy on `app.organization_id`, `GRANT` to `backstory_app` when the role exists, and `REVOKE ALL` from `anon` and `authenticated` — copy the block from `prisma/migrations/20260827160000_rls_flow_reviews_audit_streams/migration.sql`.
- All schema changes are additive. No column is dropped, no existing default changes.
- Every `repository_*` tool is `isWrite: false`. No exceptions — a guard test enforces it.
- Retrieval is best-effort by contract: `retrieveKnowledge` never throws, returns `[]` on failure.
- UI copy uses plain English. No raw identifiers, `{{token}}` syntax, or cron strings in any user-facing string.
- Migrations are named `prisma/migrations/YYYYMMDDHHMMSS_<snake_name>/migration.sql`.
- Bounds: `topK` clamps to 1-20; `repository_read` `limit` defaults to 8000 chars and clamps to 20000; the agent manifest is at most 25 entries and 1500 characters.
- Run `npx tsc --noEmit` and `npm test` before each commit. Local `npm run build` is expected to fail (no Supabase env locally) — that is not a regression, builds validate on Vercel.

## Build order note (refines the spec)

The spec lists WS1 (tools) before WS2 (collections). This plan swaps them: `repository_search` takes a `collection` filter and every tool reads through the shared scope predicate that WS2 introduces. Building collections first means the tools are written once. Final order: **WS3 → WS2 → WS1 → WS4 → WS5 → WS6**.

## File Structure

**Created**
- `src/lib/knowledge/index-state.ts` — pure `deriveIndexState`; no DB, no network.
- `src/lib/knowledge/scope.ts` — the single scope predicate, in raw-SQL and Prisma-where forms.
- `src/lib/knowledge/collections.ts` — collection CRUD and agent attachment service.
- `src/lib/knowledge/tools.ts` — `REPOSITORY_TOOLS` descriptors + `RepositoryToolClient`.
- `src/lib/knowledge/manifest.ts` — pure renderer for the agent-facing repository manifest.
- `src/lib/knowledge/reembed-sweep.ts` — batched knowledge-chunk re-embed pass.
- `src/lib/rag/reembed-decision.ts` — pure decision helpers shared by the sweep and the ops script.
- `src/app/api/cron/reembed-sweep/route.ts` — cron entry point (auth + response shaping only).
- `src/app/api/repository/collections/route.ts`, `src/app/api/repository/collections/[id]/route.ts`
- `src/app/api/repository/[id]/reindex/route.ts`
- `src/app/api/agents/[id]/collections/route.ts`

**Modified**
- `prisma/schema.prisma` — three columns on `KnowledgeDocument`, three new models, four back-relations.
- `src/lib/knowledge/ingest.ts` — persist index state, index error, truncation.
- `src/lib/knowledge/retrieve.ts` — scope predicate, per-document keyword fallback, `matchedBy`, citation handles.
- `src/lib/knowledge/repository.ts` — surface the new fields; collection filtering.
- `src/lib/connectors/registry.ts` — the `repository` builtin descriptor.
- `src/features/agents/tool-planes.ts` — the `backstory://repository` native plane.
- `src/features/agents/execute-agent.ts:1186` — manifest replaces passage injection.
- `src/lib/mcp/server/tools.ts`, `src/app/api/mcp/route.ts` — MCP tool exposure.
- `src/features/flows/run-action-step.ts:556-571` — scoped knowledge step.
- `src/components/repository/content-repository.tsx` — collections, index state, truncation.
- `src/app/agents/knowledge-panel.tsx` — attached collections.
- `scripts/reembed-backfill.ts` — import the extracted decision helpers.
- `vercel.json` — the new cron entry.

---

## WS3 — Indexing trust

### Task 1: Index-state and truncation columns

**Files:**
- Create: `src/lib/knowledge/index-state.ts`
- Create: `prisma/migrations/20260901120000_knowledge_index_state/migration.sql`
- Modify: `prisma/schema.prisma` (model `KnowledgeDocument`, after the `error` field)
- Test: `src/lib/knowledge/__tests__/index-state.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type IndexState = 'indexed' | 'partial' | 'unindexed' | 'pending'`; `deriveIndexState(totalChunks: number, embeddedChunks: number): IndexState`. Columns `KnowledgeDocument.indexState: string`, `.indexError: string | null`, `.truncated: boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/knowledge/__tests__/index-state.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveIndexState } from '../index-state'

test('a document with no chunks yet is pending', () => {
  assert.equal(deriveIndexState(0, 0), 'pending')
})

test('chunks with no vectors at all are unindexed', () => {
  assert.equal(deriveIndexState(5, 0), 'unindexed')
})

test('some vectors missing is partial', () => {
  assert.equal(deriveIndexState(5, 3), 'partial')
})

test('every chunk embedded is indexed', () => {
  assert.equal(deriveIndexState(5, 5), 'indexed')
})

test('more embedded than counted never reports partial', () => {
  // Defensive: a racing sweep can report a higher embedded count than the
  // snapshot total. Clamp rather than emit a nonsense state.
  assert.equal(deriveIndexState(5, 6), 'indexed')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/knowledge/__tests__/index-state.test.ts`
Expected: FAIL — cannot find module `../index-state`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/knowledge/index-state.ts
/**
 * How completely a repository document has been embedded.
 *
 * This is the column that stops a document from being silently unretrievable:
 * anything other than 'indexed' means the vector path cannot see some of its
 * chunks, so `retrieveKnowledge` supplements it with a keyword pass and the
 * repository UI shows the state instead of a bare "ready".
 */
export type IndexState = 'indexed' | 'partial' | 'unindexed' | 'pending'

export function deriveIndexState(totalChunks: number, embeddedChunks: number): IndexState {
  if (totalChunks <= 0) return 'pending'
  if (embeddedChunks <= 0) return 'unindexed'
  if (embeddedChunks >= totalChunks) return 'indexed'
  return 'partial'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/lib/knowledge/__tests__/index-state.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the schema columns**

In `prisma/schema.prisma`, model `KnowledgeDocument`, immediately after `error String?`:

```prisma
  /// How completely this asset is embedded — see src/lib/knowledge/index-state.ts.
  /// Anything but 'indexed' means the vector path cannot see some chunks, so
  /// retrieval supplements it with a keyword pass rather than silently
  /// returning nothing.
  indexState   String   @default("pending") // indexed | partial | unindexed | pending
  /// Why embedding failed, when it did. Persisted rather than swallowed so a
  /// dead document can explain itself.
  indexError   String?
  /// Set when extraction hit KNOWLEDGE_MAX_CHARS or KNOWLEDGE_MAX_CHUNKS: the
  /// original is intact and downloadable, but only part of it is indexed.
  truncated    Boolean  @default(false)
```

And add to the same model's index list:

```prisma
  @@index([organizationId, indexState])
```

- [ ] **Step 6: Write the migration**

```sql
-- prisma/migrations/20260901120000_knowledge_index_state/migration.sql
ALTER TABLE "knowledge_documents"
  ADD COLUMN "indexState" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "indexError" TEXT,
  ADD COLUMN "truncated" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "knowledge_documents_organizationId_indexState_idx"
  ON "knowledge_documents" ("organizationId", "indexState");

-- Backfill from the chunks that already exist, so the first sweep only has to
-- fix genuinely broken documents rather than re-derive the whole table.
UPDATE "knowledge_documents" d SET "indexState" = CASE
  WHEN NOT EXISTS (SELECT 1 FROM "knowledge_chunks" c WHERE c."documentId" = d."id")
    THEN 'pending'
  WHEN NOT EXISTS (SELECT 1 FROM "knowledge_chunks" c WHERE c."documentId" = d."id" AND c."embeddingVec" IS NOT NULL)
    THEN 'unindexed'
  WHEN EXISTS (SELECT 1 FROM "knowledge_chunks" c WHERE c."documentId" = d."id" AND c."embeddingVec" IS NULL)
    THEN 'partial'
  ELSE 'indexed'
END;
```

- [ ] **Step 7: Regenerate the client and typecheck**

Run: `npx prisma generate && npx tsc --noEmit`
Expected: both succeed.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260901120000_knowledge_index_state src/lib/knowledge/index-state.ts src/lib/knowledge/__tests__/index-state.test.ts
git commit -m "feat(knowledge): index-state and truncation columns on repository documents"
```

---

### Task 2: Ingest persists index state, embedding errors and truncation

**Files:**
- Modify: `src/lib/knowledge/ingest.ts`
- Test: `src/lib/knowledge/__tests__/ingest-index-state.db.test.ts`

**Interfaces:**
- Consumes: `deriveIndexState` (Task 1).
- Produces: after any ingest or content replacement, `KnowledgeDocument.indexState`, `.indexError` and `.truncated` reflect reality. `normalizedContent(raw)` now returns `{ text: string; truncated: boolean }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/knowledge/__tests__/ingest-index-state.db.test.ts
import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  delete process.env.VOYAGE_API_KEY // no provider: every chunk lands without a vector

  let prisma: any
  let ingestKnowledgeFile: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ ingestKnowledgeFile } = await import('../ingest'))
    const org = await prisma.organization.create({
      data: { name: 'ingest-state Org', slug: `ingest-state-${Date.now()}` },
    })
    ids.org = org.id
  })

  test('a document ingested with no embedding provider is marked unindexed, not ready-and-silent', async () => {
    const doc = await ingestKnowledgeFile({
      organizationId: ids.org,
      agentId: null,
      userId: null,
      filename: 'journey.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('Stage one is discovery. Stage two is validation.'),
    })
    const row = await prisma.knowledgeDocument.findUnique({ where: { id: doc.id } })
    assert.equal(row.status, 'ready')
    assert.equal(row.indexState, 'unindexed')
    assert.equal(row.truncated, false)
  })

  test('extraction beyond the character cap sets truncated', async () => {
    const doc = await ingestKnowledgeFile({
      organizationId: ids.org,
      agentId: null,
      userId: null,
      filename: 'huge.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('word '.repeat(60_000)), // 300k chars > KNOWLEDGE_MAX_CHARS
    })
    const row = await prisma.knowledgeDocument.findUnique({ where: { id: doc.id } })
    assert.equal(row.truncated, true)
    assert.ok(row.charCount <= 200_000)
  })
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ci_repro npx tsx --test src/lib/knowledge/__tests__/ingest-index-state.db.test.ts`
Expected: FAIL — `indexState` is `'pending'`, not `'unindexed'`.

- [ ] **Step 3: Make `normalizedContent` report truncation**

In `src/lib/knowledge/ingest.ts`, replace the existing `normalizedContent`:

```ts
function normalizedContent(raw: string): { text: string; truncated: boolean } {
  const trimmed = raw.trim()
  const text = trimmed.slice(0, KNOWLEDGE_MAX_CHARS)
  if (!text) throw new UnsupportedFileError('No readable text was found in that file.')
  return { text, truncated: trimmed.length > KNOWLEDGE_MAX_CHARS }
}
```

- [ ] **Step 4: Record the embedding failure instead of discarding it**

Replace `embeddingsFor` with a version that reports why it gave up. Ingestion still succeeds — a document you can read but not vector-search beats a failed upload — but the reason is now persisted:

```ts
async function embeddingsFor(
  chunks: string[],
): Promise<{ vectors: number[][] | null; error: string | null }> {
  if (!chunks.length) return { vectors: null, error: null }
  if (!embeddingsConfigured()) {
    return { vectors: null, error: 'No embedding provider is configured for this deployment.' }
  }
  try {
    return { vectors: await embedTexts(chunks, { inputType: 'document' }), error: null }
  } catch (error) {
    // Retrieval degrades to the per-document keyword pass rather than failing
    // the upload — but the reason is persisted so the document can say why it
    // is only keyword-searchable, and so the sweep can retry it.
    return { vectors: null, error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) }
  }
}
```

- [ ] **Step 5: Persist the derived state**

In `replaceKnowledgeDocumentContent`, change the top of the function and the final `knowledgeDocument.update` call:

```ts
  const { text, truncated } = normalizedContent(params.content)
  const chunks = chunkText(text).slice(0, KNOWLEDGE_MAX_CHUNKS)
  const { vectors: embeddings, error: indexError } = await embeddingsFor(chunks)
  const chunkCapHit = chunkText(text).length > KNOWLEDGE_MAX_CHUNKS
```

Every later reference to the old `chunks`/`embeddings` names is unchanged. In the same transaction's closing `tx.knowledgeDocument.update`, add to `data`:

```ts
        indexState: deriveIndexState(chunks.length, embeddings ? chunks.length : 0),
        indexError,
        truncated: truncated || chunkCapHit,
```

Import `deriveIndexState` at the top:

```ts
import { deriveIndexState } from './index-state'
```

- [ ] **Step 6: Apply the same treatment to `ingestKnowledgeFile`**

`ingestKnowledgeFile` routes its content through `replaceKnowledgeDocumentContent`, so it inherits the fields. Read the function and confirm this; if it writes chunks directly, mirror the three fields in its own `update` call rather than duplicating the derivation.

- [ ] **Step 7: Run the tests**

Run: `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ci_repro npx tsx --test src/lib/knowledge/__tests__/ingest-index-state.db.test.ts`
Expected: PASS (2 tests).

Run: `npx tsc --noEmit && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/knowledge/ingest.ts src/lib/knowledge/__tests__/ingest-index-state.db.test.ts
git commit -m "feat(knowledge): ingest records index state, embedding errors and truncation"
```

---

### Task 3: Per-document keyword fallback so an unindexed document is never invisible

**Files:**
- Modify: `src/lib/knowledge/retrieve.ts`
- Test: `src/lib/knowledge/__tests__/retrieve-merge.test.ts`
- Test: `src/lib/knowledge/__tests__/retrieve-fallback.db.test.ts`

**Interfaces:**
- Consumes: `deriveIndexState` semantics (Task 1), `keywordScore` (existing).
- Produces: `KnowledgeHit` gains `matchedBy?: 'vector' | 'keyword'`; exported `KEYWORD_ADMISSION_SCORE = 0.5` and `mergeHits(vectorHits, keywordHits, k)`.

- [ ] **Step 1: Write the failing merge test**

```ts
// src/lib/knowledge/__tests__/retrieve-merge.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeHits, KEYWORD_ADMISSION_SCORE, type KnowledgeHit } from '../retrieve'

const vec = (id: string, score: number): KnowledgeHit =>
  ({ content: `v-${id}`, filename: `${id}.md`, documentId: id, score, matchedBy: 'vector' })
const kw = (id: string, score: number): KnowledgeHit =>
  ({ content: `k-${id}`, filename: `${id}.md`, documentId: id, score, matchedBy: 'keyword' })

test('vector hits fill the result set first', () => {
  const merged = mergeHits([vec('a', 0.9), vec('b', 0.8)], [kw('c', 1)], 2)
  assert.deepEqual(merged.map((h) => h.documentId), ['a', 'b'])
})

test('keyword hits only fill remaining slots', () => {
  const merged = mergeHits([vec('a', 0.9)], [kw('c', 1)], 3)
  assert.deepEqual(merged.map((h) => h.documentId), ['a', 'c'])
  assert.equal(merged[1].matchedBy, 'keyword')
})

test('keyword hits below the admission score are dropped', () => {
  const merged = mergeHits([], [kw('c', KEYWORD_ADMISSION_SCORE - 0.01)], 5)
  assert.deepEqual(merged, [])
})

test('a keyword hit never displaces a vector hit', () => {
  const merged = mergeHits([vec('a', 0.4)], [kw('c', 1)], 1)
  assert.deepEqual(merged.map((h) => h.documentId), ['a'])
})

test('the same passage is not returned twice', () => {
  const dup: KnowledgeHit = { content: 'same', filename: 'a.md', documentId: 'a', score: 0.9, matchedBy: 'vector' }
  const merged = mergeHits([dup], [{ ...dup, score: 1, matchedBy: 'keyword' }], 5)
  assert.equal(merged.length, 1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/knowledge/__tests__/retrieve-merge.test.ts`
Expected: FAIL — `mergeHits` is not exported.

- [ ] **Step 3: Implement the merge rule**

In `src/lib/knowledge/retrieve.ts`, extend the hit type and add the merge:

```ts
export type KnowledgeHit = {
  content: string
  filename: string
  score: number
  documentId?: string
  /** Which retrieval path produced this hit. Keyword hits come from documents
   *  whose chunks are not fully embedded — honest about a degraded match. */
  matchedBy?: 'vector' | 'keyword'
}

/**
 * Minimum query-term overlap for a keyword hit to be worth showing. Below
 * this, a "match" is one incidental word and is noise next to a vector hit.
 */
export const KEYWORD_ADMISSION_SCORE = 0.5

/**
 * Combine the two retrieval paths without pretending their scores are
 * comparable — cosine similarity and term overlap are different scales, so
 * they are not sorted together. Vector hits fill the result set; keyword hits
 * only fill what is left, and only when they clear the admission score.
 */
export function mergeHits(vectorHits: KnowledgeHit[], keywordHits: KnowledgeHit[], k: number): KnowledgeHit[] {
  const out = vectorHits.slice(0, k)
  if (out.length >= k) return out
  const seen = new Set(out.map((hit) => `${hit.documentId ?? ''}:${hit.content}`))
  for (const hit of keywordHits) {
    if (out.length >= k) break
    if (hit.score < KEYWORD_ADMISSION_SCORE) continue
    const key = `${hit.documentId ?? ''}:${hit.content}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(hit)
  }
  return out
}
```

- [ ] **Step 4: Run the merge test**

Run: `npx tsx --test src/lib/knowledge/__tests__/retrieve-merge.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing database test**

```ts
// src/lib/knowledge/__tests__/retrieve-fallback.db.test.ts
import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.VOYAGE_API_KEY = 'test-key' // the query embeds; the document does not

  let prisma: any
  let retrieveKnowledge: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ retrieveKnowledge } = await import('../retrieve'))
    const org = await prisma.organization.create({
      data: { name: 'fallback Org', slug: `fallback-${Date.now()}` },
    })
    ids.org = org.id
    const agent = await prisma.agentTask.create({
      data: { organizationId: org.id, description: 'fallback agent', objective: 'test' },
    })
    ids.agent = agent.id
    const doc = await prisma.knowledgeDocument.create({
      data: {
        organizationId: org.id,
        agentId: agent.id,
        filename: 'journey.md',
        mimeType: 'text/markdown',
        status: 'ready',
        isEnabled: true,
        indexState: 'unindexed', // the whole point: no vectors at all
      },
    })
    ids.document = doc.id
    await prisma.knowledgeChunk.create({
      data: {
        documentId: doc.id,
        organizationId: org.id,
        agentId: agent.id,
        ordinal: 0,
        content: 'The renewal stage requires a documented success plan and an executive sponsor.',
      },
    })
  })

  test('an unindexed document is still reachable by keyword rather than invisible', async () => {
    const hits = await retrieveKnowledge({
      organizationId: ids.org,
      agentId: ids.agent,
      query: 'renewal stage executive sponsor',
    })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].documentId, ids.document)
    assert.equal(hits[0].matchedBy, 'keyword')
  })
}
```

- [ ] **Step 6: Run it to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ci_repro npx tsx --test src/lib/knowledge/__tests__/retrieve-fallback.db.test.ts`
Expected: FAIL — zero hits. The vector path skips NULL vectors and the keyword path never runs because the query embedded fine. This failure IS gap 2.

- [ ] **Step 7: Wire the supplementary pass into `retrieveKnowledge`**

Inside the `if (queryVec)` branch, after the existing `hits` are built and the relevance floor applied, add the supplementary pass before returning:

```ts
      const vectorHits = applyRelevanceFloor(
        rows.map((row) => ({
          content: row.content,
          filename: row.filename,
          documentId: row.documentId,
          score: 1 - row.distance,
          matchedBy: 'vector' as const,
        })),
        params.minScore,
      )
      if (vectorHits.length >= k) return vectorHits

      // Supplementary pass: documents whose chunks are not fully embedded are
      // invisible to the query above (it requires embeddingVec IS NOT NULL).
      // Score those by term overlap so a document that failed to embed is
      // degraded, not silently absent. Bounded scan — this is a fallback, not
      // a second index.
      const unindexedChunks = await prisma.knowledgeChunk.findMany({
        where: {
          organizationId: params.organizationId,
          document: {
            organizationId: params.organizationId,
            OR: [{ agentId: params.agentId }, { agentId: null }],
            isEnabled: true,
            status: 'ready',
            indexState: { not: 'indexed' },
          },
        },
        select: { content: true, document: { select: { id: true, filename: true } } },
        take: 500,
      })
      const keywordHits = unindexedChunks
        .map((chunk) => ({
          content: chunk.content,
          filename: chunk.document.filename,
          documentId: chunk.document.id,
          score: keywordScore(params.query, chunk.content),
          matchedBy: 'keyword' as const,
        }))
        .sort((a, b) => b.score - a.score)
      return mergeHits(vectorHits, keywordHits, k)
```

Tag the existing no-embeddings fallback's hits with `matchedBy: 'keyword'` too, so the field is always populated.

- [ ] **Step 8: Run both tests**

Run: `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ci_repro npx tsx --test src/lib/knowledge/__tests__/retrieve-fallback.db.test.ts src/lib/knowledge/__tests__/retrieve-vector.test.ts`
Expected: PASS. The existing vector test must still pass unchanged — it proves the primary path did not regress.

Run: `npx tsc --noEmit && npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/knowledge/retrieve.ts src/lib/knowledge/__tests__/retrieve-merge.test.ts src/lib/knowledge/__tests__/retrieve-fallback.db.test.ts
git commit -m "fix(knowledge): an unindexed document degrades to keyword search instead of vanishing"
```

---

### Task 4: Re-embed sweep and its cron

**Files:**
- Create: `src/lib/rag/reembed-decision.ts`
- Create: `src/lib/knowledge/reembed-sweep.ts`
- Create: `src/app/api/cron/reembed-sweep/route.ts`
- Modify: `scripts/reembed-backfill.ts` (import the extracted helpers, delete the local copies)
- Modify: `vercel.json`
- Test: `src/lib/knowledge/__tests__/reembed-sweep.db.test.ts`

**Interfaces:**
- Consumes: `deriveIndexState` (Task 1), `embedTexts`/`toSqlVector`/`EMBEDDING_DIM` (existing).
- Produces: `runReembedSweep(options?: { fetchImpl?: typeof fetch }): Promise<ReembedSweepResult>` where `ReembedSweepResult = { scanned, converted, reembedded, skipped, failed, skippedNoProvider }`; `REEMBED_SWEEP_BATCH_SIZE = 100`.

> **Note on the spec:** the spec says to extract the loop from `scripts/reembed-backfill.ts`. That script covers two models (`knowledge_chunks` and `agent_memories`); this sweep is knowledge-only. So extract the *pure decision helpers* to `src/lib/rag/reembed-decision.ts` — shared by both — and give the sweep its own knowledge-specific batch loop. Same intent, no duplicated decision logic.

- [ ] **Step 1: Extract the pure helpers**

Create `src/lib/rag/reembed-decision.ts` by moving `RowAction`, `isValidLegacyVector`, `BackfillRow`, `decideAction`, `chunk` and `estimateTokens` verbatim out of `scripts/reembed-backfill.ts` (they are already pure and already unit-tested):

```ts
// src/lib/rag/reembed-decision.ts
/**
 * Pure decision logic for filling a NULL `embeddingVec`, shared by the ops
 * script (scripts/reembed-backfill.ts) and the scheduled sweep
 * (src/lib/knowledge/reembed-sweep.ts). No DB, no network.
 */
import { EMBEDDING_DIM } from './embeddings'

export type RowAction = 'convert' | 'reembed' | 'skip'

export interface BackfillRow {
  id: string
  text: string
  legacyEmbedding: unknown
}

/** A legacy `embedding Json?` value is usable iff it's a number[] of exactly `dim` finite numbers. */
export function isValidLegacyVector(value: unknown, dim: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === dim &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  )
}

/** Decide what one row needs, preferring a free legacy conversion over a paid re-embed. */
export function decideAction(row: BackfillRow, dim: number = EMBEDDING_DIM): RowAction {
  if (isValidLegacyVector(row.legacyEmbedding, dim)) return 'convert'
  if (row.text.trim().length > 0) return 'reembed'
  return 'skip'
}

/** Split items into stable, order-preserving batches of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be positive')
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Rough token estimate for a cost preview (~4 chars/token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
```

Then in `scripts/reembed-backfill.ts`, delete those definitions and import them:

```ts
import { decideAction, isValidLegacyVector, chunk, estimateTokens, type BackfillRow, type RowAction } from '../src/lib/rag/reembed-decision'
```

- [ ] **Step 2: Verify the script's existing tests still pass**

Run: `npx tsx --test scripts/reembed-backfill.test.ts`
Expected: PASS — the helpers moved but their behavior did not. Update the import path inside that test file to `../src/lib/rag/reembed-decision` if it imports from the script.

- [ ] **Step 3: Write the failing sweep test**

```ts
// src/lib/knowledge/__tests__/reembed-sweep.db.test.ts
import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.VOYAGE_API_KEY = 'test-key'

  let prisma: any
  let runReembedSweep: any
  const ids: Record<string, string> = {}
  let vectorReady = false

  // Stub the provider: one 1024-dim vector per input, no network.
  const fetchImpl = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body)
    const count = Array.isArray(body.input) ? body.input.length : 1
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: Array.from({ length: count }, () => ({ embedding: Array.from({ length: 1024 }, () => 0.01) })),
      }),
    }
  }) as unknown as typeof fetch

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ runReembedSweep } = await import('../reembed-sweep'))
    const available = await prisma.$queryRaw`SELECT 1 FROM pg_extension WHERE extname = 'vector'`
    vectorReady = Array.isArray(available) && available.length > 0
    if (!vectorReady) return
    const org = await prisma.organization.create({
      data: { name: 'sweep Org', slug: `sweep-${Date.now()}` },
    })
    ids.org = org.id
    const doc = await prisma.knowledgeDocument.create({
      data: {
        organizationId: org.id,
        filename: 'journey.md',
        mimeType: 'text/markdown',
        status: 'ready',
        indexState: 'unindexed',
      },
    })
    ids.document = doc.id
    await prisma.knowledgeChunk.create({
      data: { documentId: doc.id, organizationId: org.id, ordinal: 0, content: 'Renewal stage exit criteria.' },
    })
  })

  test('the sweep fills NULL vectors and promotes the document to indexed', async (t) => {
    if (!vectorReady) return t.skip('pgvector not installed')
    const result = await runReembedSweep({ fetchImpl })
    assert.ok(result.reembedded >= 1)
    const row = await prisma.knowledgeDocument.findUnique({ where: { id: ids.document } })
    assert.equal(row.indexState, 'indexed')
  })

  test('a second pass finds nothing left to do', async (t) => {
    if (!vectorReady) return t.skip('pgvector not installed')
    const result = await runReembedSweep({ fetchImpl })
    assert.equal(result.scanned, 0)
  })
}
```

- [ ] **Step 4: Run it to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ci_repro npx tsx --test src/lib/knowledge/__tests__/reembed-sweep.db.test.ts`
Expected: FAIL — cannot find module `../reembed-sweep`.

- [ ] **Step 5: Write the sweep**

```ts
// src/lib/knowledge/reembed-sweep.ts
/**
 * Knowledge-chunk re-embed sweep.
 *
 * A chunk with `embeddingVec IS NULL` is invisible to the vector retrieval
 * path. Ingestion degrades to that state rather than failing an upload when
 * the embedding provider is unavailable, so something has to come back and
 * finish the job — this is that something, run at cron cadence.
 *
 * One cron invocation is exactly one bounded pass. There is no internal retry
 * loop: a chunk that fails stays NULL and is picked up on the next tick, which
 * makes the sweep idempotent and safe against a permanently failing row.
 *
 * systemPrisma: cross-org maintenance by design (cron, not a request context),
 * matching src/lib/activity/indexer-sweep.ts and scripts/reembed-backfill.ts.
 */

import { Prisma } from '@prisma/client'
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { embedTexts, embeddingsConfigured, toSqlVector, EMBEDDING_DIM } from '@/lib/rag/embeddings'
import { decideAction, isValidLegacyVector, type BackfillRow } from '@/lib/rag/reembed-decision'
import { deriveIndexState } from './index-state'

export const REEMBED_SWEEP_BATCH_SIZE = 100

export interface ReembedSweepResult {
  scanned: number
  converted: number
  reembedded: number
  skipped: number
  failed: number
  /** True when the pass did nothing because no embedding provider is configured. */
  skippedNoProvider: boolean
}

type SweepRow = BackfillRow & { documentId: string }

export async function runReembedSweep(
  options: { fetchImpl?: typeof fetch } = {},
): Promise<ReembedSweepResult> {
  const empty: ReembedSweepResult = {
    scanned: 0, converted: 0, reembedded: 0, skipped: 0, failed: 0, skippedNoProvider: false,
  }
  if (!embeddingsConfigured()) return { ...empty, skippedNoProvider: true }

  const rows = await systemPrisma.$queryRaw<Array<{ id: string; documentId: string; content: string; embedding: unknown }>>`
    SELECT "id", "documentId", "content", "embedding"
      FROM "knowledge_chunks"
     WHERE "embeddingVec" IS NULL
     ORDER BY "id" ASC
     LIMIT ${REEMBED_SWEEP_BATCH_SIZE}
  `
  if (rows.length === 0) return empty

  const candidates: SweepRow[] = rows.map((row) => ({
    id: row.id,
    documentId: row.documentId,
    text: row.content ?? '',
    legacyEmbedding: row.embedding,
  }))

  const toWrite: Array<{ id: string; vector: number[] }> = []
  let converted = 0
  let reembedded = 0
  let skipped = 0
  let failed = 0

  const toReembed: SweepRow[] = []
  for (const row of candidates) {
    const action = decideAction(row)
    if (action === 'convert' && isValidLegacyVector(row.legacyEmbedding, EMBEDDING_DIM)) {
      toWrite.push({ id: row.id, vector: row.legacyEmbedding })
      converted += 1
    } else if (action === 'reembed') {
      toReembed.push(row)
    } else {
      skipped += 1
    }
  }

  if (toReembed.length) {
    try {
      const vectors = await embedTexts(
        toReembed.map((row) => row.text),
        { inputType: 'document', ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) },
      )
      for (let i = 0; i < toReembed.length; i += 1) {
        const vector = vectors[i]
        if (!vector || vector.length !== EMBEDDING_DIM) {
          failed += 1
          continue
        }
        toWrite.push({ id: toReembed[i].id, vector })
        reembedded += 1
      }
    } catch (error) {
      failed += toReembed.length
      apiLogger.warn('knowledge/reembed-sweep: embed failed, rows stay NULL for the next tick', {
        count: toReembed.length,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (toWrite.length) {
    const values = toWrite.map((pair) => Prisma.sql`(${pair.id}::text, ${toSqlVector(pair.vector)}::vector(1024))`)
    await systemPrisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL search_path = public, extensions')
      await tx.$executeRaw`
        UPDATE "knowledge_chunks" AS c
           SET "embeddingVec" = v.vec
          FROM (VALUES ${Prisma.join(values)}) AS v(id, vec)
         WHERE c."id" = v.id
      `
    })
  }

  await recomputeIndexState([...new Set(candidates.map((row) => row.documentId))])

  return { scanned: rows.length, converted, reembedded, skipped, failed, skippedNoProvider: false }
}

/** Re-derive `indexState` for the documents this pass touched. */
async function recomputeIndexState(documentIds: string[]): Promise<void> {
  for (const documentId of documentIds) {
    const [counts] = await systemPrisma.$queryRaw<Array<{ total: bigint; embedded: bigint }>>`
      SELECT COUNT(*) AS total,
             COUNT("embeddingVec") AS embedded
        FROM "knowledge_chunks"
       WHERE "documentId" = ${documentId}
    `
    const state = deriveIndexState(Number(counts?.total ?? 0), Number(counts?.embedded ?? 0))
    await systemPrisma.knowledgeDocument.update({
      where: { id: documentId },
      data: { indexState: state, ...(state === 'indexed' ? { indexError: null } : {}) },
    })
  }
}
```

- [ ] **Step 6: Run the sweep test**

Run: `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ci_repro npx tsx --test src/lib/knowledge/__tests__/reembed-sweep.db.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Add the cron route**

Copy `src/app/api/cron/indexer-sweep/route.ts` verbatim to `src/app/api/cron/reembed-sweep/route.ts`, changing only the doc comment, the import and the call:

```ts
/**
 * /api/cron/reembed-sweep — Vercel Cron handler
 *
 * Fills `knowledge_chunks.embeddingVec` for rows ingested while the embedding
 * provider was unavailable (100 per tick — see
 * `src/lib/knowledge/reembed-sweep.ts`), then re-derives each touched
 * document's `indexState`. Same fail-closed CRON_SECRET auth as the other
 * `/api/cron/*` routes; this file is auth plus response shaping only.
 */

import { timingSafeEqual } from 'crypto'
import { apiLogger } from '@/lib/logger'
import { runReembedSweep } from '@/lib/knowledge/reembed-sweep'
import { recordTokenRejection } from '@/lib/security/events'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'
```

Keep `checkAuthorized` byte-identical to the indexer-sweep version (`timingSafeEqual`, 503 when `CRON_SECRET` is unset, `recordTokenRejection` on mismatch), and have `GET` call `runReembedSweep()`.

- [ ] **Step 8: Register the schedule**

In `vercel.json`, add to the `crons` array after the `indexer-sweep` entry:

```json
    {
      "path": "/api/cron/reembed-sweep",
      "schedule": "*/10 * * * *"
    }
```

- [ ] **Step 9: Verify and commit**

Run: `npx tsc --noEmit && npm test`
Expected: PASS, including the route-coverage test picking up the new cron route.

```bash
git add src/lib/rag/reembed-decision.ts src/lib/knowledge/reembed-sweep.ts src/app/api/cron/reembed-sweep scripts/reembed-backfill.ts vercel.json src/lib/knowledge/__tests__/reembed-sweep.db.test.ts
git commit -m "feat(knowledge): scheduled re-embed sweep fills NULL vectors and re-derives index state"
```

---

### Task 5: Surface index state and offer a manual re-index

**Files:**
- Create: `src/app/api/repository/[id]/reindex/route.ts`
- Modify: `src/lib/knowledge/repository.ts` (serializer)
- Modify: `src/components/repository/content-repository.tsx`
- Test: `src/components/repository/__tests__/content-repository.test.tsx`

**Interfaces:**
- Consumes: `findVisibleRepositoryAsset`, `replaceKnowledgeDocumentContent` (existing).
- Produces: serialized assets gain `indexState`, `indexError`, `truncated`. `POST /api/repository/:id/reindex` returns `{ success: true, document }`.

- [ ] **Step 1: Extend the serializer**

In `src/lib/knowledge/repository.ts`, add to `RepositoryRow`:

```ts
  indexState: string
  indexError: string | null
  truncated: boolean
```

and to the object `serialize` returns, next to `status`:

```ts
    indexState: row.indexState,
    indexError: row.indexError,
    truncated: row.truncated,
```

- [ ] **Step 2: Write the failing UI test**

Add to `src/components/repository/__tests__/content-repository.test.tsx`, following the file's existing render-and-assert style:

```tsx
test('an unindexed asset says so instead of reading as ready', async () => {
  const asset = {
    ...baseAsset,
    status: 'ready',
    indexState: 'unindexed',
    indexError: 'Embedding provider returned 429.',
  }
  const { findByText } = renderRepository({ assets: [asset] })
  await findByText(/not searchable/i)
})

test('a truncated asset says only part of it is indexed', async () => {
  const asset = { ...baseAsset, truncated: true, charCount: 200_000 }
  const { findByText } = renderRepository({ assets: [asset] })
  await findByText(/partly indexed/i)
})
```

Reuse the file's existing `baseAsset` and `renderRepository` helpers; if they are not present under those names, use whatever the file already defines and keep the two assertions.

- [ ] **Step 3: Run it to verify it fails**

Run: `npx tsx --test src/components/repository/__tests__/content-repository.test.tsx`
Expected: FAIL — the text is not rendered.

- [ ] **Step 4: Render the state**

In `content-repository.tsx`, in the status `TableCell`, after the existing status `Badge`:

```tsx
{asset.indexState === 'unindexed' && (
  <Badge variant="destructive" className="mt-1" title={asset.indexError ?? undefined}>
    Not searchable
  </Badge>
)}
{asset.indexState === 'partial' && (
  <Badge variant="secondary" className="mt-1">Partly searchable</Badge>
)}
{asset.truncated && (
  <p className="mt-1 text-[11px] text-muted-foreground">
    Partly indexed — the file is longer than the indexing limit. The original download is complete.
  </p>
)}
```

Add a "Re-index" item to the row's dropdown menu, shown when `writable && asset.indexState !== 'indexed'`, that POSTs to `/api/repository/${asset.id}/reindex` and reloads on success.

- [ ] **Step 5: Add the re-index route**

```ts
// src/app/api/repository/[id]/reindex/route.ts
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { findVisibleRepositoryAsset, RepositoryAssetNotFoundError } from '@/lib/knowledge/repository'
import { replaceKnowledgeDocumentContent } from '@/lib/knowledge/ingest'
import { recordAudit } from '@/lib/audit'

export const runtime = 'nodejs'

export const POST = withAuthenticatedApi(async (_request, auth, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params
  const asset = await findVisibleRepositoryAsset({
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    id,
    includeContent: true,
  }).catch((error) => {
    if (error instanceof RepositoryAssetNotFoundError) throw new ApiError(error.message, 404, 'ASSET_NOT_FOUND')
    throw error
  })
  if (!asset.content) throw new ApiError('This asset has no indexed text to rebuild.', 409, 'NO_CONTENT')

  // Re-chunks and re-embeds from the canonical text. The original bytes in
  // StoredFile are untouched.
  await replaceKnowledgeDocumentContent({
    organizationId: auth.organizationId,
    documentId: asset.id,
    agentId: asset.agentId,
    content: asset.content,
  })
  await recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    action: 'repository.reindexed',
    resourceType: 'repository_asset',
    resourceId: asset.id,
    detail: { filename: asset.filename },
  })
  return {
    success: true,
    document: await findVisibleRepositoryAsset({ organizationId: auth.organizationId, userId: auth.dbUser.id, id: asset.id }),
  }
}, { permission: 'flow.write' })
```

Match the `context`/`params` signature used by the sibling `src/app/api/repository/[id]/route.ts` — read it first and copy its exact handler shape.

- [ ] **Step 6: Run tests and commit**

Run: `npx tsc --noEmit && npm test`
Expected: PASS.

```bash
git add src/lib/knowledge/repository.ts src/components/repository/content-repository.tsx src/components/repository/__tests__/content-repository.test.tsx src/app/api/repository/\[id\]/reindex
git commit -m "feat(repository): show index state and truncation, offer a manual re-index"
```

---

## WS2 — Collections

### Task 6: Collection schema, back-relations and RLS

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260901130000_knowledge_collections/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: models `KnowledgeCollection`, `KnowledgeDocumentCollection`, `AgentKnowledgeCollection` with tables `knowledge_collections`, `knowledge_document_collections`, `agent_knowledge_collections`.

- [ ] **Step 1: Add the models**

Append to `prisma/schema.prisma`, after `model KnowledgeChunk`:

```prisma
/// A named set of repository assets — "Customer Journey", "Competitive" —
/// attachable to many agents at once. Without this, an enablement library is
/// either org-wide or bound to exactly one agent, and re-attaching every new
/// document by hand is the only way to serve a team of agents.
model KnowledgeCollection {
  id             String   @id @default(cuid())
  organizationId String   @db.Uuid
  name           String
  description    String   @default("") @db.Text
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  organization Organization                 @relation(fields: [organizationId], references: [id], onDelete: Cascade)
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

- [ ] **Step 2: Add the four back-relations**

Prisma will not generate without them.

- `model Organization` (near the existing `knowledgeDocuments KnowledgeDocument[]` at line 95):
  ```prisma
  knowledgeCollections KnowledgeCollection[]
  ```
- `model KnowledgeDocument` (next to `chunks KnowledgeChunk[]`):
  ```prisma
  collections KnowledgeDocumentCollection[]
  ```
- `model AgentTask`:
  ```prisma
  knowledgeCollections AgentKnowledgeCollection[]
  ```

- [ ] **Step 3: Verify the schema generates**

Run: `npx prisma generate`
Expected: succeeds. If it reports a missing opposite relation, add it where named — do not remove the relation.

- [ ] **Step 4: Write the migration, RLS included**

```sql
-- prisma/migrations/20260901130000_knowledge_collections/migration.sql
CREATE TABLE "knowledge_collections" (
  "id"             TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "name"           TEXT NOT NULL,
  "description"    TEXT NOT NULL DEFAULT '',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "knowledge_collections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "knowledge_document_collections" (
  "documentId"     TEXT NOT NULL,
  "collectionId"   TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  CONSTRAINT "knowledge_document_collections_pkey" PRIMARY KEY ("documentId", "collectionId")
);

CREATE TABLE "agent_knowledge_collections" (
  "agentId"        TEXT NOT NULL,
  "collectionId"   TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  CONSTRAINT "agent_knowledge_collections_pkey" PRIMARY KEY ("agentId", "collectionId")
);

CREATE UNIQUE INDEX "knowledge_collections_organizationId_name_key"
  ON "knowledge_collections" ("organizationId", "name");
CREATE INDEX "knowledge_collections_organizationId_updatedAt_idx"
  ON "knowledge_collections" ("organizationId", "updatedAt");
CREATE INDEX "knowledge_document_collections_organizationId_collectionId_idx"
  ON "knowledge_document_collections" ("organizationId", "collectionId");
CREATE INDEX "agent_knowledge_collections_organizationId_agentId_idx"
  ON "agent_knowledge_collections" ("organizationId", "agentId");

ALTER TABLE "knowledge_collections"
  ADD CONSTRAINT "knowledge_collections_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "knowledge_document_collections"
  ADD CONSTRAINT "knowledge_document_collections_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "knowledge_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_document_collections"
  ADD CONSTRAINT "knowledge_document_collections_collectionId_fkey"
  FOREIGN KEY ("collectionId") REFERENCES "knowledge_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_knowledge_collections"
  ADD CONSTRAINT "agent_knowledge_collections_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_knowledge_collections"
  ADD CONSTRAINT "agent_knowledge_collections_collectionId_fkey"
  FOREIGN KEY ("collectionId") REFERENCES "knowledge_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation, byte-for-byte the block from
-- 20260827160000_rls_flow_reviews_audit_streams. The application queries are
-- already org-scoped; this makes the database enforce the same boundary and
-- keeps direct SQL mistakes fail-closed.
DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'knowledge_collections', 'knowledge_document_collections', 'agent_knowledge_collections'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("organizationId" = nullif(current_setting(''app.organization_id'', true), '''')::uuid) WITH CHECK ("organizationId" = nullif(current_setting(''app.organization_id'', true), '''')::uuid)',
      table_name
    );

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backstory_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO backstory_app', table_name);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon', table_name);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated', table_name);
    END IF;
  END LOOP;
END
$rls$;
```

Confirm the referenced table names (`organizations`, `agent_tasks`) against `prisma/schema.prisma`'s `@@map` directives before running — correct the FK targets if they differ.

- [ ] **Step 5: Apply from zero and check for drift**

Run: `npx prisma migrate reset --force --skip-seed && npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code`
Expected: migrations apply cleanly and the diff reports no drift.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260901130000_knowledge_collections
git commit -m "feat(knowledge): collections schema with tenant isolation"
```

---

### Task 7: One scope predicate, three call sites

**Files:**
- Create: `src/lib/knowledge/scope.ts`
- Modify: `src/lib/knowledge/retrieve.ts`
- Test: `src/lib/knowledge/__tests__/scope.test.ts`
- Test: `src/lib/knowledge/__tests__/retrieve-collections.db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `agentScopeSql(organizationId: string, agentId: string): Prisma.Sql` and `agentScopeWhere(organizationId: string, agentId: string): Prisma.KnowledgeDocumentWhereInput`. `retrieveKnowledge` accepts an optional `collectionId?: string`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/knowledge/__tests__/scope.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentScopeSql, agentScopeWhere } from '../scope'

test('the SQL predicate covers direct, org-wide and collection attachment', () => {
  const sql = agentScopeSql('00000000-0000-0000-0000-000000000001', 'agent_1').sql
  assert.ok(sql.includes('"agentId"'))
  assert.ok(sql.includes('IS NULL'))
  assert.ok(sql.includes('agent_knowledge_collections'))
  assert.ok(sql.includes('knowledge_document_collections'))
})

test('the Prisma predicate offers the same three branches', () => {
  const where = agentScopeWhere('00000000-0000-0000-0000-000000000001', 'agent_1')
  assert.equal(where.OR?.length, 3)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --test src/lib/knowledge/__tests__/scope.test.ts`
Expected: FAIL — cannot find module `../scope`.

- [ ] **Step 3: Write the predicate**

```ts
// src/lib/knowledge/scope.ts
/**
 * Which repository assets an agent may retrieve, expressed once.
 *
 * Three ways an asset reaches an agent: bound to it directly (`agentId`),
 * shared with the whole workspace (`agentId IS NULL`), or attached through a
 * collection the agent subscribes to. The vector path, the keyword fallback
 * and the Prisma-side queries all need this rule, and a copy that drifts is a
 * silent visibility bug — so there is exactly one definition, in two dialects.
 */

import { Prisma } from '@prisma/client'

/** Raw-SQL form, for the pgvector queries. Emits a bare boolean expression. */
export function agentScopeSql(organizationId: string, agentId: string): Prisma.Sql {
  return Prisma.sql`(
    d."agentId" = ${agentId}
    OR d."agentId" IS NULL
    OR d."id" IN (
      SELECT dc."documentId"
        FROM "knowledge_document_collections" dc
        JOIN "agent_knowledge_collections" ac ON ac."collectionId" = dc."collectionId"
       WHERE ac."agentId" = ${agentId}
         AND ac."organizationId" = ${organizationId}::uuid
    )
  )`
}

/** Prisma form, for the keyword fallback and any ORM-side listing. */
export function agentScopeWhere(
  organizationId: string,
  agentId: string,
): Prisma.KnowledgeDocumentWhereInput {
  return {
    OR: [
      { agentId },
      { agentId: null },
      { collections: { some: { collection: { agents: { some: { agentId, organizationId } } } } } },
    ],
  }
}
```

- [ ] **Step 4: Run the unit test**

Run: `npx tsx --test src/lib/knowledge/__tests__/scope.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing database test**

```ts
// src/lib/knowledge/__tests__/retrieve-collections.db.test.ts
import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  delete process.env.VOYAGE_API_KEY // keyword path; scoping is what is under test

  let prisma: any
  let retrieveKnowledge: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ retrieveKnowledge } = await import('../retrieve'))

    const org = await prisma.organization.create({ data: { name: 'coll Org', slug: `coll-${Date.now()}` } })
    const otherOrg = await prisma.organization.create({ data: { name: 'other', slug: `coll-other-${Date.now()}` } })
    ids.org = org.id
    const agent = await prisma.agentTask.create({
      data: { organizationId: org.id, description: 'collection agent', objective: 'test' },
    })
    ids.agent = agent.id
    const collection = await prisma.knowledgeCollection.create({
      data: { organizationId: org.id, name: 'Customer Journey' },
    })
    ids.collection = collection.id
    await prisma.agentKnowledgeCollection.create({
      data: { agentId: agent.id, collectionId: collection.id, organizationId: org.id },
    })

    const seed = async (orgId: string, agentId: string | null, filename: string, content: string) => {
      const doc = await prisma.knowledgeDocument.create({
        data: { organizationId: orgId, agentId, filename, mimeType: 'text/plain', status: 'ready', isEnabled: true, indexState: 'unindexed' },
      })
      await prisma.knowledgeChunk.create({
        data: { documentId: doc.id, organizationId: orgId, agentId, ordinal: 0, content },
      })
      return doc.id
    }

    // Reachable only through the collection — attached to no agent directly.
    ids.viaCollection = await seed(ids.org, null, 'journey.md', 'renewal stage exit criteria documented')
    await prisma.knowledgeDocumentCollection.create({
      data: { documentId: ids.viaCollection, collectionId: collection.id, organizationId: org.id },
    })
    // Another org's document with identical text — must never appear.
    ids.foreign = await seed(otherOrg.id, null, 'foreign.md', 'renewal stage exit criteria documented')
  })

  test('a document reaches an agent through its collection', async () => {
    const hits = await retrieveKnowledge({
      organizationId: ids.org,
      agentId: ids.agent,
      query: 'renewal stage exit criteria documented',
    })
    assert.ok(hits.some((hit: any) => hit.documentId === ids.viaCollection))
  })

  test('another org is never reachable, identical text or not', async () => {
    const hits = await retrieveKnowledge({
      organizationId: ids.org,
      agentId: ids.agent,
      query: 'renewal stage exit criteria documented',
    })
    assert.equal(hits.some((hit: any) => hit.documentId === ids.foreign), false)
  })
}
```

- [ ] **Step 6: Run it to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ci_repro npx tsx --test src/lib/knowledge/__tests__/retrieve-collections.db.test.ts`
Expected: the first test FAILS (collection document not returned); the second passes already.

- [ ] **Step 7: Use the predicate in both retrieval paths**

In `retrieve.ts`, add `collectionId?: string` to the `retrieveKnowledge` params type and import the helpers:

```ts
import { agentScopeSql, agentScopeWhere } from './scope'
```

In the raw vector query, replace the line

```sql
            AND (d."agentId" = ${params.agentId} OR d."agentId" IS NULL)
```

with

```ts
            AND ${agentScopeSql(params.organizationId, params.agentId)}
            ${params.collectionId
              ? Prisma.sql`AND d."id" IN (SELECT "documentId" FROM "knowledge_document_collections" WHERE "collectionId" = ${params.collectionId} AND "organizationId" = ${params.organizationId}::uuid)`
              : Prisma.empty}
```

(import `Prisma` from `@prisma/client` if it is not already imported).

In both Prisma-side chunk queries (the supplementary pass from Task 3 and the no-embeddings fallback), replace

```ts
            OR: [{ agentId: params.agentId }, { agentId: null }],
```

with a spread of the shared predicate:

```ts
            ...agentScopeWhere(params.organizationId, params.agentId),
            ...(params.collectionId
              ? { collections: { some: { collectionId: params.collectionId } } }
              : {}),
```

- [ ] **Step 8: Run the tests**

Run: `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ci_repro npx tsx --test src/lib/knowledge/__tests__/retrieve-collections.db.test.ts src/lib/knowledge/__tests__/retrieve-vector.test.ts src/lib/knowledge/__tests__/retrieve-fallback.db.test.ts`
Expected: PASS. The cross-org assertion is the load-bearing one — if it ever fails, stop and fix before continuing.

Run: `npx tsc --noEmit && npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/knowledge/scope.ts src/lib/knowledge/retrieve.ts src/lib/knowledge/__tests__/scope.test.ts src/lib/knowledge/__tests__/retrieve-collections.db.test.ts
git commit -m "feat(knowledge): collection-aware retrieval through one shared scope predicate"
```

---

### Task 8: Collection service and API

**Files:**
- Create: `src/lib/knowledge/collections.ts`
- Create: `src/app/api/repository/collections/route.ts`
- Create: `src/app/api/repository/collections/[id]/route.ts`
- Create: `src/app/api/agents/[id]/collections/route.ts`
- Test: `src/lib/knowledge/__tests__/collections.db.test.ts`

**Interfaces:**
- Consumes: `assertRepositoryAgentScope` (existing, `repository.ts`).
- Produces:
  - `listCollections({ organizationId }): Promise<Array<{ id, name, description, documentCount, agentCount }>>`
  - `createCollection({ organizationId, name, description })`
  - `renameCollection({ organizationId, id, name, description })`
  - `deleteCollection({ organizationId, id })`
  - `setDocumentCollections({ organizationId, documentId, collectionIds })`
  - `setAgentCollections({ organizationId, userId, agentId, collectionIds })`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/knowledge/__tests__/collections.db.test.ts
import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let svc: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    svc = await import('../collections')
    const org = await prisma.organization.create({ data: { name: 'svc Org', slug: `svc-${Date.now()}` } })
    ids.org = org.id
    const doc = await prisma.knowledgeDocument.create({
      data: { organizationId: org.id, filename: 'a.md', mimeType: 'text/markdown' },
    })
    ids.document = doc.id
  })

  test('a collection is created and counted', async () => {
    const created = await svc.createCollection({ organizationId: ids.org, name: 'Customer Journey', description: 'Stage map' })
    ids.collection = created.id
    const list = await svc.listCollections({ organizationId: ids.org })
    const found = list.find((c: any) => c.id === created.id)
    assert.equal(found.name, 'Customer Journey')
    assert.equal(found.documentCount, 0)
  })

  test('setting a document\'s collections is idempotent', async () => {
    await svc.setDocumentCollections({ organizationId: ids.org, documentId: ids.document, collectionIds: [ids.collection] })
    await svc.setDocumentCollections({ organizationId: ids.org, documentId: ids.document, collectionIds: [ids.collection] })
    const list = await svc.listCollections({ organizationId: ids.org })
    assert.equal(list.find((c: any) => c.id === ids.collection).documentCount, 1)
  })

  test('deleting a collection leaves its documents alone', async () => {
    await svc.deleteCollection({ organizationId: ids.org, id: ids.collection })
    const doc = await prisma.knowledgeDocument.findUnique({ where: { id: ids.document } })
    assert.ok(doc, 'the document must survive its collection')
    const joins = await prisma.knowledgeDocumentCollection.count({ where: { documentId: ids.document } })
    assert.equal(joins, 0)
  })
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ci_repro npx tsx --test src/lib/knowledge/__tests__/collections.db.test.ts`
Expected: FAIL — cannot find module `../collections`.

- [ ] **Step 3: Write the service**

```ts
// src/lib/knowledge/collections.ts
/**
 * Collections: named sets of repository assets, attachable to many agents.
 *
 * Deleting a collection removes the grouping, never the documents — the join
 * rows cascade, the assets do not. That asymmetry is deliberate: a collection
 * is a label, and deleting a label must not destroy what it labelled.
 */

import { prisma } from '@/lib/prisma'
import { assertRepositoryAgentScope } from './repository'

export class CollectionNotFoundError extends Error {}

const cleanName = (value: string) => value.replace(/[\r\n]/g, ' ').trim().slice(0, 120)

export async function listCollections(params: { organizationId: string }) {
  const rows = await prisma.knowledgeCollection.findMany({
    where: { organizationId: params.organizationId },
    orderBy: { name: 'asc' },
    include: { _count: { select: { documents: true, agents: true } } },
  })
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    documentCount: row._count.documents,
    agentCount: row._count.agents,
    updatedAt: row.updatedAt,
  }))
}

export async function createCollection(params: { organizationId: string; name: string; description?: string }) {
  const name = cleanName(params.name)
  if (!name) throw new CollectionNotFoundError('A collection needs a name.')
  return prisma.knowledgeCollection.create({
    data: {
      organizationId: params.organizationId,
      name,
      description: (params.description ?? '').trim().slice(0, 2_000),
    },
  })
}

export async function renameCollection(params: {
  organizationId: string
  id: string
  name?: string
  description?: string
}) {
  const updated = await prisma.knowledgeCollection.updateMany({
    where: { id: params.id, organizationId: params.organizationId },
    data: {
      ...(params.name !== undefined ? { name: cleanName(params.name) } : {}),
      ...(params.description !== undefined ? { description: params.description.trim().slice(0, 2_000) } : {}),
    },
  })
  if (updated.count !== 1) throw new CollectionNotFoundError('Collection not found.')
  return prisma.knowledgeCollection.findFirst({ where: { id: params.id, organizationId: params.organizationId } })
}

export async function deleteCollection(params: { organizationId: string; id: string }) {
  const deleted = await prisma.knowledgeCollection.deleteMany({
    where: { id: params.id, organizationId: params.organizationId },
  })
  if (deleted.count !== 1) throw new CollectionNotFoundError('Collection not found.')
  return { id: params.id }
}

/** Replace a document's collection membership wholesale. Idempotent. */
export async function setDocumentCollections(params: {
  organizationId: string
  documentId: string
  collectionIds: string[]
}) {
  const valid = await prisma.knowledgeCollection.findMany({
    where: { organizationId: params.organizationId, id: { in: params.collectionIds } },
    select: { id: true },
  })
  await prisma.$transaction([
    prisma.knowledgeDocumentCollection.deleteMany({
      where: { documentId: params.documentId, organizationId: params.organizationId },
    }),
    prisma.knowledgeDocumentCollection.createMany({
      data: valid.map((collection) => ({
        documentId: params.documentId,
        collectionId: collection.id,
        organizationId: params.organizationId,
      })),
      skipDuplicates: true,
    }),
  ])
  return valid.map((collection) => collection.id)
}

/** Replace an agent's attached collections wholesale. Idempotent. */
export async function setAgentCollections(params: {
  organizationId: string
  userId: string
  agentId: string
  collectionIds: string[]
}) {
  // Reuses the repository's agent-visibility check: you cannot attach a
  // collection to an agent you are not allowed to see.
  await assertRepositoryAgentScope({
    organizationId: params.organizationId,
    userId: params.userId,
    agentId: params.agentId,
  })
  const valid = await prisma.knowledgeCollection.findMany({
    where: { organizationId: params.organizationId, id: { in: params.collectionIds } },
    select: { id: true },
  })
  await prisma.$transaction([
    prisma.agentKnowledgeCollection.deleteMany({
      where: { agentId: params.agentId, organizationId: params.organizationId },
    }),
    prisma.agentKnowledgeCollection.createMany({
      data: valid.map((collection) => ({
        agentId: params.agentId,
        collectionId: collection.id,
        organizationId: params.organizationId,
      })),
      skipDuplicates: true,
    }),
  ])
  return valid.map((collection) => collection.id)
}
```

- [ ] **Step 4: Run the service test**

Run: `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ci_repro npx tsx --test src/lib/knowledge/__tests__/collections.db.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the routes**

All three follow the `withAuthenticatedApi` shape used across `src/app/api/repository/*`: `permission: 'flow.read'` for GET, `'flow.write'` for mutations, validating bodies with `zod` exactly as `src/app/api/repository/[id]/route.ts` does.

```ts
// src/app/api/repository/collections/route.ts
import { z } from 'zod'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { listCollections, createCollection } from '@/lib/knowledge/collections'

export const runtime = 'nodejs'

export const GET = withAuthenticatedApi(async (_request, auth) => {
  return { success: true, collections: await listCollections({ organizationId: auth.organizationId }) }
}, { permission: 'flow.read' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const body = z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000).optional(),
  }).parse(await request.json())
  return { success: true, collection: await createCollection({ organizationId: auth.organizationId, ...body }) }
}, { permission: 'flow.write' })
```

`collections/[id]/route.ts` exposes `PATCH` (→ `renameCollection`) and `DELETE` (→ `deleteCollection`), translating `CollectionNotFoundError` to `new ApiError(message, 404, 'COLLECTION_NOT_FOUND')`.

`agents/[id]/collections/route.ts` exposes `GET` (the agent's attached collection ids) and `PUT` (→ `setAgentCollections` with `collectionIds: z.array(z.string()).max(50)`).

Also extend `POST /api/repository` and `PATCH /api/repository/[id]` to accept an optional `collectionIds` array and call `setDocumentCollections` after the asset is written.

- [ ] **Step 6: Run tests and commit**

Run: `npx tsc --noEmit && npm test`
Expected: PASS, including the route-coverage test finding the three new routes with declared permissions.

```bash
git add src/lib/knowledge/collections.ts src/app/api/repository/collections src/app/api/agents/\[id\]/collections src/app/api/repository/route.ts src/app/api/repository/\[id\]/route.ts src/lib/knowledge/__tests__/collections.db.test.ts
git commit -m "feat(knowledge): collection service and API"
```

---

### Task 9: Collections in the UI

**Files:**
- Modify: `src/components/repository/content-repository.tsx`
- Modify: `src/app/agents/knowledge-panel.tsx`
- Test: `src/components/repository/__tests__/content-repository.test.tsx`

**Interfaces:**
- Consumes: the Task 8 routes.
- Produces: no new exports; UI only.

- [ ] **Step 1: Write the failing test**

```tsx
test('assets show their collections and can be filtered by one', async () => {
  const { findByText, getByLabelText } = renderRepository({
    assets: [{ ...baseAsset, collections: [{ id: 'c1', name: 'Customer Journey' }] }],
    collections: [{ id: 'c1', name: 'Customer Journey', documentCount: 1, agentCount: 2 }],
  })
  await findByText('Customer Journey')
  assert.ok(getByLabelText(/filter by collection/i))
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --test src/components/repository/__tests__/content-repository.test.tsx`
Expected: FAIL — neither the collection name nor the filter control is rendered.

- [ ] **Step 3: Implement the repository-side UI**

In `content-repository.tsx`:
- Load `/api/repository/collections` alongside the asset list.
- Add a `Collections` column rendering each asset's collection names as badges, or an em dash when it belongs to none.
- Add a select above the table, labelled "Filter by collection", whose options are "All collections" plus each collection by name. Selecting one adds `&collectionId=` to the list request.
- Add a multi-select of collections to the upload, project and edit dialogs, posting `collectionIds`.
- Add a "Manage collections" dialog with create, rename and delete. The delete confirmation must say: "Deleting a collection removes the grouping. The files stay in your repository."

- [ ] **Step 4: Implement the agent-side UI**

In `knowledge-panel.tsx`, below the existing file list, add an "Attached collections" section: fetch `/api/agents/${agentId}/collections`, render checkboxes for every workspace collection, and `PUT` the selected ids on change. Copy under it: "Files in these collections are available to this agent."

- [ ] **Step 5: Run tests and commit**

Run: `npx tsx --test src/components/repository/__tests__/content-repository.test.tsx && npx tsc --noEmit && npm run lint`
Expected: PASS, with no `jsx-a11y` violations — every new control needs a label.

```bash
git add src/components/repository/content-repository.tsx src/app/agents/knowledge-panel.tsx src/components/repository/__tests__/content-repository.test.tsx
git commit -m "feat(repository): manage collections and attach them to agents"
```

---

## WS1 — The tool set

### Task 10: `REPOSITORY_TOOLS` and `RepositoryToolClient`

**Files:**
- Create: `src/lib/knowledge/tools.ts`
- Test: `src/lib/knowledge/__tests__/tools.test.ts`
- Test: `src/lib/knowledge/__tests__/tools.db.test.ts`

**Interfaces:**
- Consumes: `agentScopeWhere` (Task 7), `retrieveKnowledge` (Task 3/7), `listCollections` (Task 8), `findVisibleRepositoryAsset` (existing).
- Produces: `REPOSITORY_TOOLS: ReadonlyArray<{ name, description, isWrite: false, inputSchema }>`; `repositoryToolIsWrite(name: string): boolean`; `class RepositoryToolClient` with `executeTool(serverUrl, name, args)`; `REPOSITORY_READ_DEFAULT_LIMIT = 8000`, `REPOSITORY_READ_MAX_LIMIT = 20000`.

- [ ] **Step 1: Write the failing schema test**

```ts
// src/lib/knowledge/__tests__/tools.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REPOSITORY_TOOLS, repositoryToolIsWrite } from '../tools'

test('the repository exposes exactly search, read and list', () => {
  assert.deepEqual(
    REPOSITORY_TOOLS.map((tool) => tool.name).sort(),
    ['repository_list', 'repository_read', 'repository_search'],
  )
})

test('every repository tool is read-only', () => {
  for (const tool of REPOSITORY_TOOLS) {
    assert.equal(tool.isWrite, false, `${tool.name} must be read-only`)
    assert.equal(repositoryToolIsWrite(tool.name), false)
  }
})

test('an unknown tool is treated as a write, never as a safe read', () => {
  assert.equal(repositoryToolIsWrite('repository_delete_everything'), true)
})

test('every tool declares an object input schema and describes itself', () => {
  for (const tool of REPOSITORY_TOOLS) {
    assert.equal(tool.inputSchema.type, 'object')
    assert.ok(tool.description.length > 30, `${tool.name} needs a usable description`)
  }
})

test('repository_search requires a query and repository_read requires a documentId', () => {
  const search = REPOSITORY_TOOLS.find((tool) => tool.name === 'repository_search')!
  assert.deepEqual(search.inputSchema.required, ['query'])
  const read = REPOSITORY_TOOLS.find((tool) => tool.name === 'repository_read')!
  assert.deepEqual(read.inputSchema.required, ['documentId'])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --test src/lib/knowledge/__tests__/tools.test.ts`
Expected: FAIL — cannot find module `../tools`.

- [ ] **Step 3: Write the tool definitions**

```ts
// src/lib/knowledge/tools.ts
/**
 * The repository as agent-callable tools.
 *
 * Before these existed, an agent received five passages chosen before the run
 * started, from a query built out of its objective — it could not look
 * anything up, ask a better question, or read a document it knew it needed.
 * These three tools are that missing half; `repository_read` in particular is
 * what makes a long document usable, because `nextOffset` lets an agent walk
 * it instead of sampling it.
 *
 * Defined once and registered twice: as the `backstory://repository` native
 * plane for agents (src/features/agents/tool-planes.ts) and as MCP tools for
 * external callers (src/app/api/mcp/route.ts). Every tool is read-only.
 */

import { prisma } from '@/lib/prisma'
import { retrieveKnowledge } from './retrieve'
import { agentScopeWhere } from './scope'
import { listCollections } from './collections'

export const REPOSITORY_SEARCH_DEFAULT_K = 8
export const REPOSITORY_READ_DEFAULT_LIMIT = 8_000
export const REPOSITORY_READ_MAX_LIMIT = 20_000
export const REPOSITORY_LIST_MAX = 100

export const REPOSITORY_TOOLS = [
  {
    name: 'repository_search',
    description:
      'Search the workspace repository of reference material — enablement docs, customer journey maps, playbooks, synced project files — and get back the most relevant passages with the document they came from. Use this whenever the answer depends on how this company does things rather than on general knowledge. Prefer a specific question over a keyword.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to know, in a sentence.' },
        collection: { type: 'string', description: 'Optional collection name to search within, e.g. Customer Journey.' },
        documentId: { type: 'string', description: 'Optional: restrict the search to one document.' },
        topK: { type: 'number', description: 'How many passages to return, 1-20. Defaults to 8.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'repository_read',
    description:
      'Read a repository document straight through, a window at a time. Use this after repository_search when passages are not enough and you need the document in order — a stage-by-stage journey map, a full playbook. Pass the returned nextOffset back to continue; a null nextOffset means you have reached the end.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'The document id, from repository_search or repository_list.' },
        offset: { type: 'number', description: 'Character offset to start at. Defaults to 0.' },
        limit: { type: 'number', description: `Characters to return, up to ${REPOSITORY_READ_MAX_LIMIT}. Defaults to ${REPOSITORY_READ_DEFAULT_LIMIT}.` },
      },
      required: ['documentId'],
    },
  },
  {
    name: 'repository_list',
    description:
      'List the reference documents and collections available to you, with their descriptions. Use this to find out what exists before searching, or when a search comes back empty and you want to know whether the material is there at all.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Optional collection name to list within.' },
        search: { type: 'string', description: 'Optional filter on file name or description.' },
      },
    },
  },
] satisfies ReadonlyArray<{
  name: string
  description: string
  isWrite: false
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
}>
// NOTE: plain `satisfies`, deliberately not `as const satisfies` — `as const`
// would make `required` a readonly tuple, which does not satisfy `string[]`.

/** Unknown names default to write — an unrecognized tool never bypasses the approval gate. */
export function repositoryToolIsWrite(name: string): boolean {
  return REPOSITORY_TOOLS.find((tool) => tool.name === name)?.isWrite ?? true
}

const clamp = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.max(min, Math.min(max, n))
}

export class RepositoryToolClient {
  /**
   * `agentId` is the agent's own id when an agent is calling. MCP callers pass
   * null: they have no agent identity, so they see org-wide documents plus
   * every collection, bounded by the user visibility filter below.
   */
  constructor(
    private readonly organizationId: string,
    private readonly userId: string,
    private readonly agentId: string | null = null,
  ) {}

  private async collectionIdByName(name: string): Promise<string | null> {
    const row = await prisma.knowledgeCollection.findFirst({
      where: { organizationId: this.organizationId, name: { equals: name.trim(), mode: 'insensitive' } },
      select: { id: true },
    })
    return row?.id ?? null
  }

  async executeTool(_serverUrl: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'repository_search': {
        const query = String(args.query ?? '').trim()
        if (!query) return { passages: [], note: 'Pass a question to search for.' }
        const collectionId = typeof args.collection === 'string' && args.collection.trim()
          ? await this.collectionIdByName(args.collection)
          : null
        if (typeof args.collection === 'string' && args.collection.trim() && !collectionId) {
          return { passages: [], note: `There is no collection named "${args.collection}". Call repository_list to see what exists.` }
        }
        const hits = await retrieveKnowledge({
          organizationId: this.organizationId,
          // '' matches no agent row, so an MCP caller gets the org-wide branch.
          agentId: this.agentId ?? '',
          query,
          k: clamp(args.topK, REPOSITORY_SEARCH_DEFAULT_K, 1, 20),
          ...(collectionId ? { collectionId } : {}),
        })
        const filtered = typeof args.documentId === 'string'
          ? hits.filter((hit) => hit.documentId === args.documentId)
          : hits
        return {
          passages: filtered.map((hit) => ({
            documentId: hit.documentId,
            filename: hit.filename,
            text: hit.content,
            score: Number(hit.score.toFixed(3)),
            matchedBy: hit.matchedBy ?? 'vector',
            citation: `[doc:${hit.documentId} "${hit.filename}"]`,
          })),
        }
      }

      case 'repository_read': {
        const documentId = String(args.documentId ?? '')
        const document = await prisma.knowledgeDocument.findFirst({
          where: {
            id: documentId,
            organizationId: this.organizationId,
            isEnabled: true,
            status: 'ready',
            ...(this.agentId
              ? agentScopeWhere(this.organizationId, this.agentId)
              : { OR: [{ agentId: null }, { userId: this.userId }] }),
          },
          select: { id: true, filename: true, description: true, content: true, truncated: true },
        })
        if (!document) return { error: 'No readable document with that id is available to you.' }
        const text = document.content ?? ''
        const offset = clamp(args.offset, 0, 0, Math.max(0, text.length))
        const limit = clamp(args.limit, REPOSITORY_READ_DEFAULT_LIMIT, 1, REPOSITORY_READ_MAX_LIMIT)
        const slice = text.slice(offset, offset + limit)
        const nextOffset = offset + slice.length < text.length ? offset + slice.length : null
        return {
          documentId: document.id,
          filename: document.filename,
          description: document.description,
          totalChars: text.length,
          offset,
          nextOffset,
          truncatedAtIngest: document.truncated,
          citation: `[doc:${document.id} "${document.filename}"]`,
          text: slice,
        }
      }

      case 'repository_list': {
        const search = typeof args.search === 'string' ? args.search.trim().slice(0, 200) : ''
        const collectionId = typeof args.collection === 'string' && args.collection.trim()
          ? await this.collectionIdByName(args.collection)
          : null
        const documents = await prisma.knowledgeDocument.findMany({
          where: {
            organizationId: this.organizationId,
            isEnabled: true,
            status: 'ready',
            ...(this.agentId
              ? agentScopeWhere(this.organizationId, this.agentId)
              : { OR: [{ agentId: null }, { userId: this.userId }] }),
            ...(collectionId ? { collections: { some: { collectionId } } } : {}),
            ...(search
              ? {
                  AND: [{
                    OR: [
                      { filename: { contains: search, mode: 'insensitive' } },
                      { description: { contains: search, mode: 'insensitive' } },
                    ],
                  }],
                }
              : {}),
          },
          orderBy: { updatedAt: 'desc' },
          take: REPOSITORY_LIST_MAX,
          select: {
            id: true, filename: true, description: true, charCount: true, indexState: true,
            collections: { select: { collection: { select: { name: true } } } },
          },
        })
        return {
          documents: documents.map((document) => ({
            documentId: document.id,
            filename: document.filename,
            description: document.description,
            chars: document.charCount,
            collections: document.collections.map((join) => join.collection.name),
            searchable: document.indexState === 'indexed' ? 'full' : 'keyword only',
          })),
          collections: (await listCollections({ organizationId: this.organizationId }))
            .map((collection) => ({ name: collection.name, documents: collection.documentCount })),
        }
      }

      default:
        throw new Error(`Unknown repository tool "${name}".`)
    }
  }
}
```

- [ ] **Step 4: Run the schema test**

Run: `npx tsx --test src/lib/knowledge/__tests__/tools.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing paging test**

```ts
// src/lib/knowledge/__tests__/tools.db.test.ts
import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  delete process.env.VOYAGE_API_KEY

  let prisma: any
  let RepositoryToolClient: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ RepositoryToolClient } = await import('../tools'))
    const org = await prisma.organization.create({ data: { name: 'tools Org', slug: `tools-${Date.now()}` } })
    ids.org = org.id
    const user = await prisma.user.create({
      data: { organizationId: org.id, email: `tools-${Date.now()}@example.com`, name: 'Tools' },
    })
    ids.user = user.id
    const doc = await prisma.knowledgeDocument.create({
      data: {
        organizationId: org.id,
        filename: 'journey.md',
        mimeType: 'text/markdown',
        status: 'ready',
        isEnabled: true,
        content: 'A'.repeat(10_000),
        charCount: 10_000,
      },
    })
    ids.document = doc.id
  })

  test('repository_read pages through a long document and terminates', async () => {
    const client = new RepositoryToolClient(ids.org, ids.user, null)
    const first: any = await client.executeTool('', 'repository_read', { documentId: ids.document })
    assert.equal(first.text.length, 8_000)
    assert.equal(first.offset, 0)
    assert.equal(first.nextOffset, 8_000)

    const second: any = await client.executeTool('', 'repository_read', { documentId: ids.document, offset: first.nextOffset })
    assert.equal(second.text.length, 2_000)
    assert.equal(second.nextOffset, null, 'the last window must report no continuation')
  })

  test('a limit beyond the maximum is clamped, not honoured', async () => {
    const client = new RepositoryToolClient(ids.org, ids.user, null)
    const page: any = await client.executeTool('', 'repository_read', { documentId: ids.document, limit: 999_999 })
    assert.ok(page.text.length <= 20_000)
  })

  test('a document in another workspace is not readable', async () => {
    const other = await prisma.organization.create({ data: { name: 'other', slug: `tools-other-${Date.now()}` } })
    const client = new RepositoryToolClient(other.id, ids.user, null)
    const result: any = await client.executeTool('', 'repository_read', { documentId: ids.document })
    assert.ok(result.error, 'cross-tenant read must not return content')
  })
}
```

Check `prisma.user.create`'s required fields against `schema.prisma` first and add any the model demands.

- [ ] **Step 6: Run it, implement nothing, confirm it passes**

Run: `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ci_repro npx tsx --test src/lib/knowledge/__tests__/tools.db.test.ts`
Expected: PASS (3 tests) — Step 3 already implements this. If any fail, fix `tools.ts`, not the test.

- [ ] **Step 7: Commit**

```bash
git add src/lib/knowledge/tools.ts src/lib/knowledge/__tests__/tools.test.ts src/lib/knowledge/__tests__/tools.db.test.ts
git commit -m "feat(knowledge): repository_search / repository_read / repository_list tools"
```

---

### Task 11: Register the native plane for agents

**Files:**
- Modify: `src/lib/connectors/registry.ts`
- Modify: `src/features/agents/tool-planes.ts`
- Test: `src/features/agents/__tests__/repository-plane.test.ts`

**Interfaces:**
- Consumes: `REPOSITORY_TOOLS`, `RepositoryToolClient`, `repositoryToolIsWrite` (Task 10).
- Produces: a `ToolPlaneGroup` with `id` = the native connection id for `repository`, `serverUrl` = `backstory://repository`.

- [ ] **Step 1: Write the failing guard test**

```ts
// src/features/agents/__tests__/repository-plane.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_CONNECTORS } from '@/lib/connectors/registry'
import { REPOSITORY_TOOLS } from '@/lib/knowledge/tools'
import { MCP_MANAGEMENT_TOOLS } from '@/lib/mcp/server/tools'

test('the repository is a builtin connector and is never classified as a write plane', () => {
  const descriptor = BUILTIN_CONNECTORS.find((connector) => connector.providerId === 'repository')
  assert.ok(descriptor, 'repository must be registered as a builtin connector')
  assert.equal(descriptor.isWrite, false)
})

test('the agent plane and the MCP surface expose the same repository tools', () => {
  const planeNames = REPOSITORY_TOOLS.map((tool) => tool.name).sort()
  const mcpNames = MCP_MANAGEMENT_TOOLS
    .filter((tool) => tool.name.startsWith('repository_'))
    .map((tool) => tool.name)
    .sort()
  assert.deepEqual(mcpNames, planeNames, 'the two surfaces must not drift apart')
})
```

The second assertion fails until Task 12; that is intentional — it is the guard that keeps the two registrations in step.

- [ ] **Step 2: Run it to verify both assertions fail**

Run: `npx tsx --test src/features/agents/__tests__/repository-plane.test.ts`
Expected: FAIL on both.

- [ ] **Step 3: Add the connector descriptor**

In `src/lib/connectors/registry.ts`, directly after the `Data Tables` entry:

```ts
  {
    key: 'Repository',
    label: 'Repository',
    slug: 'files',
    kind: 'builtin',
    // Read-only by construction: search, read, list. Nothing here mutates,
    // so the plane never triggers the approval gate.
    isWrite: false,
    providerId: 'repository',
    matches: (selected) => {
      const value = selected.toLowerCase()
      return value.includes('repository') || value.includes('knowledge') || value.includes('enablement')
    },
    available: () => true,
  },
```

- [ ] **Step 4: Register the plane**

In `src/features/agents/tool-planes.ts`, import at the top:

```ts
import { REPOSITORY_TOOLS, RepositoryToolClient } from '@/lib/knowledge/tools'
```

and add after the Data Tables block (around line 440):

```ts
  // Workspace Repository — always available and tenant-scoped, no credential.
  // Read-only, so unlike Data Tables it is classified as a read plane outright.
  const repositoryConn = BUILTIN_CONNECTORS.find((c) => c.providerId === 'repository')!
  if (selected(repositoryConn)) {
    groups.push(group(
      repositoryConn,
      'backstory://repository',
      new RepositoryToolClient(organizationId, options.httpUserId ?? '', options.agentId ?? null),
      REPOSITORY_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    ))
  }
```

Add `agentId?: string | null` to the `options` parameter type of `loadNativePlaneGroups`, and pass the agent's id from the agent call site in `execute-agent.ts` where `loadNativePlaneGroups` is invoked. Read that call site first; if it already threads an agent id under another name, reuse it rather than adding a parameter.

- [ ] **Step 5: Run the first assertion**

Run: `npx tsx --test src/features/agents/__tests__/repository-plane.test.ts`
Expected: the connector test PASSES; the parity test still fails (Task 12 closes it).

- [ ] **Step 6: Commit**

```bash
git add src/lib/connectors/registry.ts src/features/agents/tool-planes.ts src/features/agents/__tests__/repository-plane.test.ts
git commit -m "feat(agents): backstory://repository native tool plane"
```

---

### Task 12: Expose the same tools over MCP

**Files:**
- Modify: `src/lib/mcp/server/tools.ts`
- Modify: `src/app/api/mcp/route.ts`
- Test: `src/features/agents/__tests__/repository-plane.test.ts` (the parity assertion from Task 11)

**Interfaces:**
- Consumes: `REPOSITORY_TOOLS`, `RepositoryToolClient` (Task 10).
- Produces: `repository_search`, `repository_read`, `repository_list` in `MCP_MANAGEMENT_TOOLS` with `requiredScope: 'flows:read'`.

- [ ] **Step 1: Add the descriptors**

In `src/lib/mcp/server/tools.ts`, append to `MCP_MANAGEMENT_TOOLS` after the `data_table_*` entries. Derive them from the single source so the two lists cannot diverge:

```ts
  ...REPOSITORY_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // Read-only tools: the read scope is the right gate, and it keeps a
    // least-privileged management key usable against the repository.
    requiredScope: 'flows:read' as const,
    inputSchema: tool.inputSchema as McpToolDescriptor['inputSchema'],
  })),
```

with `import { REPOSITORY_TOOLS } from '@/lib/knowledge/tools'` at the top.

- [ ] **Step 2: Add the dispatch case**

In `src/app/api/mcp/route.ts`, next to the existing `data_table_*` case block:

```ts
      case 'repository_search':
      case 'repository_read':
      case 'repository_list': {
        // No agent identity on this surface: an MCP caller sees workspace-wide
        // documents and collections, bounded by the same user visibility rule
        // the repository UI applies.
        const client = new RepositoryToolClient(auth.organizationId, auth.userId, null)
        try {
          return toolResult(await client.executeTool('', name, args))
        } catch (error) {
          return toolResult(error instanceof Error ? error.message : 'Repository lookup failed.', true)
        }
      }
```

with `import { RepositoryToolClient } from '@/lib/knowledge/tools'` at the top.

- [ ] **Step 3: Run the parity test**

Run: `npx tsx --test src/features/agents/__tests__/repository-plane.test.ts`
Expected: PASS (2 tests) — both surfaces now expose the same three tools.

- [ ] **Step 4: Run the full suite**

Run: `npx tsc --noEmit && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mcp/server/tools.ts src/app/api/mcp/route.ts
git commit -m "feat(mcp): serve repository search, read and list"
```

---

### Task 13: The manifest replaces blind passage injection

**Files:**
- Create: `src/lib/knowledge/manifest.ts`
- Modify: `src/features/agents/execute-agent.ts:1181-1205`
- Test: `src/lib/knowledge/__tests__/manifest.test.ts`

**Interfaces:**
- Consumes: `agentScopeWhere` (Task 7).
- Produces: `renderRepositoryManifest(entries: ManifestEntry[]): string` and `loadManifestEntries({ organizationId, agentId })`. `MANIFEST_MAX_ENTRIES = 25`, `MANIFEST_MAX_CHARS = 1500`. New run event `knowledge.available`.

- [ ] **Step 1: Capture the eval baseline BEFORE changing anything**

Run: `npm run eval:rag`
Save the scorecard to the PR description as "before". If the harness skips for a missing `VOYAGE_API_KEY` or model key, note that in the PR and get the keys before continuing — this task's only regression risk is measured by this number.

- [ ] **Step 2: Write the failing test**

```ts
// src/lib/knowledge/__tests__/manifest.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderRepositoryManifest, MANIFEST_MAX_ENTRIES, MANIFEST_MAX_CHARS } from '../manifest'

const entry = (filename: string, description = 'stage map') => ({ filename, description, collection: 'Customer Journey' })

test('no documents produces no block at all', () => {
  assert.equal(renderRepositoryManifest([]), '')
})

test('the manifest names documents and points at the tools', () => {
  const block = renderRepositoryManifest([entry('FY26 Customer Journey.pdf')])
  assert.ok(block.includes('FY26 Customer Journey.pdf'))
  assert.ok(block.includes('stage map'))
  assert.ok(block.includes('repository_search'))
  assert.ok(block.includes('repository_read'))
})

test('it never carries passage text — only titles', () => {
  const block = renderRepositoryManifest([entry('a.md')])
  assert.equal(block.includes('From "'), false)
})

test('it caps the entry count and says how many were left out', () => {
  const many = Array.from({ length: MANIFEST_MAX_ENTRIES + 10 }, (_, i) => entry(`doc-${i}.md`, ''))
  const block = renderRepositoryManifest(many)
  assert.ok(block.includes('10 more'))
  assert.ok(block.includes('repository_list'))
})

test('it stays within the character budget', () => {
  const many = Array.from({ length: MANIFEST_MAX_ENTRIES }, (_, i) => entry(`doc-${i}.md`, 'x'.repeat(400)))
  assert.ok(renderRepositoryManifest(many).length <= MANIFEST_MAX_CHARS + 200)
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx tsx --test src/lib/knowledge/__tests__/manifest.test.ts`
Expected: FAIL — cannot find module `../manifest`.

- [ ] **Step 4: Write the manifest**

```ts
// src/lib/knowledge/manifest.ts
/**
 * What the agent is told about the repository at prompt-build time.
 *
 * The old behavior injected five passages chosen by a query built from the
 * objective, whether or not the run needed them — which both spent tokens on
 * irrelevant runs and gave a long document no way to be read properly. This
 * replaces that with an index card: titles and descriptions only, so the agent
 * knows the customer journey document exists and can decide to open it. The
 * passages come from repository_search / repository_read when it asks.
 */

import { prisma } from '@/lib/prisma'
import { agentScopeWhere } from './scope'

export const MANIFEST_MAX_ENTRIES = 25
export const MANIFEST_MAX_CHARS = 1_500

export type ManifestEntry = {
  filename: string
  description: string
  collection: string | null
}

export function renderRepositoryManifest(entries: ManifestEntry[]): string {
  if (!entries.length) return ''
  const lines: string[] = []
  let used = 0
  let shown = 0
  for (const entry of entries.slice(0, MANIFEST_MAX_ENTRIES)) {
    const description = entry.description.trim().replace(/\s+/g, ' ').slice(0, 120)
    const suffix = entry.collection ? ` (${entry.collection})` : ''
    const line = `- "${entry.filename}"${description ? ` — ${description}` : ''}${suffix}`
    if (used + line.length > MANIFEST_MAX_CHARS) break
    lines.push(line)
    used += line.length
    shown += 1
  }
  const omitted = entries.length - shown
  const overflow = omitted > 0 ? `\n…and ${omitted} more. Call repository_list to see them.` : ''
  return [
    '## Repository available to you',
    'Reference material this workspace maintains. Prefer it over general knowledge when the question is about how this company works.',
    lines.join('\n') + overflow,
    'Call repository_search for passages, repository_read to open a document in full. Cite what you use.',
  ].join('\n')
}

/** The documents this agent may reach, newest first, bounded for the prompt. */
export async function loadManifestEntries(params: {
  organizationId: string
  agentId: string
}): Promise<ManifestEntry[]> {
  const rows = await prisma.knowledgeDocument.findMany({
    where: {
      organizationId: params.organizationId,
      isEnabled: true,
      status: 'ready',
      ...agentScopeWhere(params.organizationId, params.agentId),
    },
    orderBy: { updatedAt: 'desc' },
    take: MANIFEST_MAX_ENTRIES + 25,
    select: {
      filename: true,
      description: true,
      collections: { select: { collection: { select: { name: true } } }, take: 1 },
    },
  })
  return rows.map((row) => ({
    filename: row.filename,
    description: row.description,
    collection: row.collections[0]?.collection.name ?? null,
  }))
}
```

- [ ] **Step 5: Run the test**

Run: `npx tsx --test src/lib/knowledge/__tests__/manifest.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Replace the injection block**

In `src/features/agents/execute-agent.ts`, replace the whole `try` block that currently calls `retrieveKnowledge` / `renderKnowledge` (lines ~1181-1205):

```ts
    // Repository: tell the agent WHAT is available and let it fetch what it
    // needs through the repository_* tools. Injecting passages here instead
    // meant every run paid for five passages chosen before the run started —
    // and gave a long document no way to be read in order.
    try {
      const entries = await loadManifestEntries({ organizationId, agentId: agent.id })
      const manifest = renderRepositoryManifest(entries)
      if (manifest) {
        retrievedBlocks.push(manifest)
        await recordEvent(execution.id, null, 'knowledge.available', {
          source: 'repository',
          files: entries.slice(0, MANIFEST_MAX_ENTRIES).map((entry) => entry.filename),
          summary: `Offered ${entries.length} repository document(s). The agent retrieves passages on demand.`,
        })
      }
    } catch (error) {
      apiLogger.warn('execute-agent: repository manifest skipped', {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
```

Update the imports at the top of the file: drop `retrieveKnowledge, renderKnowledge` from `@/lib/knowledge/retrieve` if nothing else in the file uses them, and add:

```ts
import { loadManifestEntries, renderRepositoryManifest, MANIFEST_MAX_ENTRIES } from '@/lib/knowledge/manifest'
```

Leave `KNOWLEDGE_RELEVANCE_FLOOR` in place only if it is still referenced; remove the import otherwise so lint stays clean.

- [ ] **Step 7: Update the system-prompt test**

Run: `npx tsx --test src/features/agents/__tests__/system-prompt.test.ts`
Expected: it may FAIL where it asserts on the old knowledge block. Update those assertions to expect the manifest heading (`## Repository available to you`) rather than `## Knowledge (from uploaded files)`. Do not delete the assertions.

- [ ] **Step 8: Run the eval and compare**

Run: `npm run eval:rag`
Expected: grounding and retrieval scores at or above the Step 1 baseline. Record both in the PR. If grounding drops materially, stop: the likely cause is the agent not calling the tools, and the fix is manifest wording, not reverting the design.

- [ ] **Step 9: Full suite and commit**

Run: `npx tsc --noEmit && npm test`
Expected: PASS.

```bash
git add src/lib/knowledge/manifest.ts src/features/agents/execute-agent.ts src/lib/knowledge/__tests__/manifest.test.ts src/features/agents/__tests__/system-prompt.test.ts
git commit -m "feat(agents): repository manifest replaces blind passage injection"
```

---

## WS4 — Citations

### Task 14: Citation handles that resolve

**Files:**
- Modify: `src/lib/knowledge/retrieve.ts` (`renderKnowledge`)
- Modify: `src/features/agents/execute-agent.ts` (tool-call event payload)
- Modify: `src/components/repository/content-repository.tsx` (deep link)
- Test: `src/lib/knowledge/__tests__/retrieve.test.ts` (extend)

**Interfaces:**
- Consumes: `KnowledgeHit.documentId` (existing), tool `citation` fields (Task 10).
- Produces: `renderKnowledge` emits `[doc:<id> "<filename>"]`; `knowledge.retrieved` events carry `documents: Array<{ id: string; filename: string }>`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/knowledge/__tests__/retrieve.test.ts`:

```ts
test('renderKnowledge emits a resolvable citation handle, not just a filename', () => {
  const block = renderKnowledge([
    { content: 'Enterprise tier is $50k', filename: 'pricing.md', documentId: 'doc_123', score: 0.9 },
  ])
  assert.ok(block.includes('[doc:doc_123 "pricing.md"]'))
})

test('a hit with no documentId still renders rather than emitting a broken handle', () => {
  const block = renderKnowledge([{ content: 'x', filename: 'pricing.md', score: 0.9 }])
  assert.ok(block.includes('pricing.md'))
  assert.equal(block.includes('[doc:undefined'), false)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --test src/lib/knowledge/__tests__/retrieve.test.ts`
Expected: FAIL on the first new test.

- [ ] **Step 3: Emit the handle**

```ts
export function renderKnowledge(hits: KnowledgeHit[]): string {
  if (!hits.length) return ''
  const body = hits
    .map((hit) => {
      const handle = hit.documentId ? `[doc:${hit.documentId} "${hit.filename}"]` : `"${hit.filename}"`
      return `— From ${handle}:\n${hit.content}`
    })
    .join('\n\n')
  return `## Knowledge (from the repository)\nUse the following reference material when relevant. When you rely on a passage, cite it with the handle shown above it, exactly as written.\n\n${body}`
}
```

- [ ] **Step 4: Record cited documents on retrieval events**

Locate the tool-result recording path:

Run: `grep -n "recordEvent(execution.id" src/features/agents/execute-agent.ts`

Find the call that records a completed tool result. Add a branch that, when the
tool name starts with `repository_`, also emits a `knowledge.retrieved` event
carrying the documents that result touched — the same payload shape the old
pre-run event used, so the run panel needs no second renderer:

```ts
      if (toolName.startsWith('repository_')) {
        const cited = extractCitedDocuments(result)
        if (cited.length) {
          await recordEvent(execution.id, null, 'knowledge.retrieved', {
            source: 'repository',
            files: [...new Set(cited.map((doc) => doc.filename))],
            documents: cited,
            summary: `Retrieved from ${new Set(cited.map((doc) => doc.filename)).size} repository document(s).`,
          })
        }
      }
```

with a small pure helper beside it — the two tools return different shapes, and
a malformed result must yield no event rather than throw inside the run:

```ts
/** Pull {id, filename} pairs out of a repository tool result, whatever its shape. */
function extractCitedDocuments(result: unknown): Array<{ id: string; filename: string }> {
  if (!result || typeof result !== 'object') return []
  const value = result as { passages?: unknown; documentId?: unknown; filename?: unknown }
  if (Array.isArray(value.passages)) {
    return value.passages
      .filter((passage): passage is { documentId: string; filename: string } =>
        Boolean(passage) && typeof passage === 'object' &&
        typeof (passage as any).documentId === 'string' &&
        typeof (passage as any).filename === 'string')
      .map((passage) => ({ id: passage.documentId, filename: passage.filename }))
  }
  if (typeof value.documentId === 'string' && typeof value.filename === 'string') {
    return [{ id: value.documentId, filename: value.filename }]
  }
  return []
}
```

Add a unit test for `extractCitedDocuments` covering a search result, a read
result, and a malformed result (which must return `[]`).

- [ ] **Step 5: Make the handle resolve in the UI**

In `content-repository.tsx`, read `doc` from the URL search params on mount and, when present and matching a loaded asset, open that asset's editor dialog. In the run panel, render `documents` entries from a `knowledge.retrieved` event as links to `/data-tables?doc=<id>`.

- [ ] **Step 6: Run tests and commit**

Run: `npx tsc --noEmit && npm test`
Expected: PASS.

```bash
git add src/lib/knowledge/retrieve.ts src/features/agents/execute-agent.ts src/components/repository/content-repository.tsx src/lib/knowledge/__tests__/retrieve.test.ts
git commit -m "feat(knowledge): citation handles that resolve back to the source document"
```

---

## WS5 — The flow knowledge step

### Task 15: Scope the knowledge step properly

**Files:**
- Modify: `src/features/flows/run-action-step.ts:556-571`
- Modify: the flow builder's knowledge-node config panel (find with `grep -rn "kind === 'knowledge'" src/components src/features --include='*.tsx'`)
- Test: `src/features/flows/__tests__/knowledge-step.test.ts`

**Interfaces:**
- Consumes: `retrieveKnowledge` with `collectionId` (Task 7), `KNOWLEDGE_RELEVANCE_FLOOR` (existing).
- Produces: node config accepts `scope: { agentId?: string; collectionId?: string }` and `minScore?: number`.

- [ ] **Step 1: Write the failing test**

```ts
// src/features/flows/__tests__/knowledge-step.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveKnowledgeStepParams } from '../run-action-step'

test('with no scope configured the step stays workspace-wide, as saved flows expect', () => {
  const params = resolveKnowledgeStepParams({ query: 'renewal criteria' })
  assert.equal(params.agentId, '')
  assert.equal(params.collectionId, undefined)
})

test('a configured agent scope is passed through', () => {
  const params = resolveKnowledgeStepParams({ query: 'x', scope: { agentId: 'agent_1' } })
  assert.equal(params.agentId, 'agent_1')
})

test('a configured collection scope is passed through', () => {
  const params = resolveKnowledgeStepParams({ query: 'x', scope: { collectionId: 'col_1' } })
  assert.equal(params.collectionId, 'col_1')
})

test('the relevance floor applies by default and is overridable', () => {
  assert.equal(resolveKnowledgeStepParams({ query: 'x' }).minScore, 0.35)
  assert.equal(resolveKnowledgeStepParams({ query: 'x', minScore: 0 }).minScore, 0)
})

test('topK clamps to the documented 1-20 range', () => {
  assert.equal(resolveKnowledgeStepParams({ query: 'x', topK: 999 }).k, 20)
  assert.equal(resolveKnowledgeStepParams({ query: 'x', topK: 0 }).k, 1)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --test src/features/flows/__tests__/knowledge-step.test.ts`
Expected: FAIL — `resolveKnowledgeStepParams` is not exported.

- [ ] **Step 3: Extract and export the pure resolver**

In `src/features/flows/run-action-step.ts`, above the executor:

```ts
/**
 * Read a knowledge node's config into retrieval parameters.
 *
 * Pure and exported so the clamping and defaulting are testable without a run.
 * An unscoped node keeps the historical workspace-wide behavior — `agentId: ''`
 * matches no agent row, so only `agentId IS NULL` documents are searched — so
 * saved flows do not change meaning under this change.
 */
export function resolveKnowledgeStepParams(config: Record<string, unknown>): {
  query: string
  agentId: string
  collectionId?: string
  k: number
  minScore: number
} {
  const scope = (config.scope && typeof config.scope === 'object' && !Array.isArray(config.scope)
    ? config.scope
    : {}) as { agentId?: unknown; collectionId?: unknown }
  const rawK = typeof config.topK === 'number' && Number.isFinite(config.topK) ? Math.round(config.topK) : 5
  return {
    query: typeof config.query === 'string' ? config.query.trim() : '',
    agentId: typeof scope.agentId === 'string' && scope.agentId ? scope.agentId : '',
    ...(typeof scope.collectionId === 'string' && scope.collectionId ? { collectionId: scope.collectionId } : {}),
    k: Math.max(1, Math.min(20, rawK)),
    minScore: typeof config.minScore === 'number' && Number.isFinite(config.minScore)
      ? config.minScore
      : KNOWLEDGE_RELEVANCE_FLOOR,
  }
}
```

Import `KNOWLEDGE_RELEVANCE_FLOOR` from `@/lib/rag/relevance`.

- [ ] **Step 4: Use it in the executor**

Replace the body of the `node.kind === 'knowledge'` branch:

```ts
      if (node.kind === 'knowledge') {
        const { query, agentId, collectionId, k, minScore } = resolveKnowledgeStepParams(node.config)
        // Best-effort by contract — an empty query or no hits is a successful
        // empty list, never a failure.
        if (!query) {
          await finish({ status: 'succeeded', output: [] })
          return { output: [] }
        }
        const hits = await retrieveKnowledge({
          organizationId: job.organizationId,
          agentId,
          query,
          k,
          minScore,
          ...(collectionId ? { collectionId } : {}),
        })
        await finish({ status: 'succeeded', output: hits })
        return { output: hits }
      }
```

- [ ] **Step 5: Add the builder control**

In the knowledge node's config panel, add a "Search in" select: "Everything shared with the workspace" (default, writes no `scope`), each collection by name (writes `scope.collectionId`), and each agent by title (writes `scope.agentId`). Plain names only — never show an id. Add a "Minimum relevance" slider labelled in plain English, defaulting to the floor.

- [ ] **Step 6: Run tests and commit**

Run: `npx tsx --test src/features/flows/__tests__/knowledge-step.test.ts && npx tsc --noEmit && npm test`
Expected: PASS.

```bash
git add src/features/flows/run-action-step.ts src/features/flows/__tests__/knowledge-step.test.ts
git commit -m "feat(flows): the knowledge step can target an agent or a collection"
```

---

## Verification before calling this done

- [ ] `npx tsc --noEmit` clean.
- [ ] `npm test` clean.
- [ ] `npm run lint` clean, including `jsx-a11y` on every new control.
- [ ] CI-mode reproduction against local Postgres: `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ci_repro npm test` — this runs the `.db.test.ts` files the default gate skips.
- [ ] `npx prisma migrate reset --force --skip-seed` applies all migrations from zero, then `npx prisma migrate diff ... --exit-code` reports no drift.
- [ ] `npm run eval:rag` scorecard recorded before Task 13 and after, both in the PR.
- [ ] Cross-tenant assertions in `retrieve-collections.db.test.ts` and `tools.db.test.ts` pass. These are load-bearing — a failure here blocks the merge.
- [ ] After deploy: `fly deploy` the worker so it picks up the repository tools.
- [ ] After deploy: confirm `/api/cron/reembed-sweep` appears in the Vercel cron list and its first run reports `skippedNoProvider: false`.

## Spec coverage map

| Spec section | Tasks |
|---|---|
| WS1 tool set | 10, 11, 12 |
| WS2 collections | 6, 7, 8, 9 |
| WS3(a) per-document fallback | 3 |
| WS3(b) honest state | 1, 2, 5 |
| WS3(c) the sweep | 4 |
| WS4 citations | 14 |
| WS5 flow step | 15 |
| WS6 truncation | 1 (column), 2 (detection), 5 (display) |
| Run-time manifest change | 13 |
| Testing strategy | every task; consolidated in "Verification before calling this done" |
| Rollout notes | "Verification before calling this done" |
