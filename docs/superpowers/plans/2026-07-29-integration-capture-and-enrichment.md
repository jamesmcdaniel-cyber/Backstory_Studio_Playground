# Integration Data Capture and Graph Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture structured facts from external tool calls agents and flows already make, resolve them onto the accounts and opportunities the graph models, and leave an inert sink for pushing them to People.ai.

**Architecture:** A fire-and-forget `captureToolResult()` call at the two run-loop sites that execute external tools. It extracts typed facts (never raw payloads), resolves them to an account via a most-deterministic-first ladder, writes them to Postgres, and indexes them into graph-RAG best-effort. Every stage is swallowed on failure — capture is never load-bearing for a user's run.

**Tech Stack:** Next.js App Router, Prisma 6 + PostgreSQL, Zod, graph-RAG (memory + Neo4j stores), `node:test` + `tsx`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-29-integration-capture-and-enrichment-design.md`. Read it before Task 1.
- **Deviation from the spec, deliberate.** The spec describes capture as a `withCapture` decorator applied where executors are constructed. That is not implementable as written: agent bindings are materialized in `src/features/agents/execute-agent.ts:178` (not `tool-planes.ts`), and `runId` — which the spec requires for provenance — exists only inside the run loop, not at construction. This plan therefore calls `captureToolResult()` explicitly at the two run-loop sites, which have full context. Everything else in the spec holds.
- **Never raw payloads.** Extraction happens in the same tick; the response is not persisted. This mirrors `AuditEvent` hashing its payloads (`src/lib/audit.ts`).
- **Capture is never load-bearing.** Every failure path logs and swallows. A capture bug must never fail a user's run.
- **Reads only.** Capture runs only when the tool's `isWrite === false`. A write's response is a confirmation, not data.
- **No raw token syntax in UI.** Never render `{{brackets}}`; plain-English labels and explicit validation messages.
- **Tenant guard.** New org-carrying models go in `ORG_SCOPED_MODELS` (`src/lib/tenant-guard.ts`). Deliberate cross-org reads use `systemPrisma` with a justification comment.
- **Local gate:** `npm run typecheck && npm run lint` before every commit. `npm run build` 500s locally without Supabase env — expected.
- **CI repro:** create a SESSION-UNIQUE database (e.g. `ci_repro_<suffix>`), never the shared name `ci_repro` — concurrent sessions drop each other's mid-run. `psql -h localhost -d postgres -c 'DROP DATABASE IF EXISTS <db>' -c 'CREATE DATABASE <db>'`, `psql -d <db> -c 'create extension if not exists vector'`, then `DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/<db> DIRECT_URL=... npx prisma migrate deploy`. Drop it afterward.
- **Single test file:** `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <path>`. Full suite: `npm test`.
- **Route-smoke completeness:** `src/app/api/__tests__/route-smoke.test.ts` fails CI if a new `withAuthenticatedApi` GET route is absent from its `cases` or documented `skipped` list. Add the case in the same commit as the route.
- **Permission coverage:** `src/app/api/__tests__/permission-coverage.test.ts` fails if a new route declares no `permission:`. Declare one.
- **Commit style:** conventional prefix, imperative subject describing behavior.

---

### Task 1: Schema — captured facts and consent

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260731000000_captured_facts/migration.sql`
- Modify: `src/lib/tenant-guard.ts:30-37`
- Test: `src/lib/__tests__/capture-schema.db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma model `CapturedFact`; `Organization.captureEnabled: boolean`, `Organization.captureProviders: string[]`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/capture-schema.db.test.ts`:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const org = await prisma.organization.create({
      data: { name: 'capture', slug: `capture-${crypto.randomUUID()}` },
    })
    ids.org = org.id
  })

  after(async () => {
    if (ids.org) await prisma.organization.delete({ where: { id: ids.org } }).catch(() => {})
  })

  test('capture is off by default with no providers allowed', async () => {
    const org = await prisma.organization.findUnique({ where: { id: ids.org } })
    assert.equal(org.captureEnabled, false)
    assert.deepEqual(org.captureProviders, [])
  })

  test('a captured fact stores extracted attributes, not a payload', async () => {
    const fact = await prisma.capturedFact.create({
      data: {
        organizationId: ids.org,
        provider: 'jira',
        tool: 'jira_list_issues',
        kind: 'issue',
        externalId: 'ACME-1',
        text: 'ACME-1: Login fails on SSO — In Progress',
        props: { status: 'In Progress', url: 'https://x/ACME-1' },
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    })
    assert.equal(fact.accountId, null, 'unresolved facts are stored unlinked')
    assert.equal(fact.props.status, 'In Progress')
  })

  test('re-observing the same record updates rather than duplicating', async () => {
    await prisma.capturedFact.upsert({
      where: { organizationId_provider_externalId: { organizationId: ids.org, provider: 'jira', externalId: 'ACME-1' } },
      create: {
        organizationId: ids.org, provider: 'jira', tool: 'jira_list_issues', kind: 'issue',
        externalId: 'ACME-1', text: 'later', expiresAt: new Date(Date.now() + 86_400_000),
      },
      update: { text: 'ACME-1: Login fails on SSO — Done' },
    })
    const rows = await prisma.capturedFact.findMany({
      where: { organizationId: ids.org, provider: 'jira', externalId: 'ACME-1' },
    })
    assert.equal(rows.length, 1)
    assert.match(rows[0].text, /Done/)
  })

  test('the tenant guard rejects an unscoped read', async () => {
    await assert.rejects(
      () => prisma.capturedFact.findMany({ where: { provider: 'jira' } }),
      /organizationId/,
    )
  })
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://james.mcdaniel@localhost:5432/<your-db> TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/__tests__/capture-schema.db.test.ts`
Expected: FAIL — `Unknown argument 'captureEnabled'` / `prisma.capturedFact is undefined`.

- [ ] **Step 3: Add the schema**

In `prisma/schema.prisma`, add to `model Organization` (after `kind`):

```prisma
  /// Capture is OFF until a workspace admin turns it on. No third-party data
  /// is stored on anyone's behalf by default.
  captureEnabled   Boolean  @default(false)
  /// Nango provider keys capture is permitted for, e.g. ['jira','zendesk'].
  /// Empty means none, even when captureEnabled is true.
  captureProviders String[] @default([])
```

Add to the `Organization` relation block: `capturedFacts CapturedFact[]`.

Add the model next to `CatalogueSubmission`:

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
  /// Stable id in the SOURCE system — dedupes re-capture across runs.
  externalId     String
  /// Human-readable text; this is what gets embedded.
  text           String    @db.Text
  /// Typed attributes: status, priority, assignee, url, updatedAt.
  props          Json      @default("{}")
  /// Resolution result. Null when nothing resolved — deliberately unlinked
  /// rather than attached to a guess.
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

- [ ] **Step 4: Write the migration**

Create `prisma/migrations/20260731000000_captured_facts/migration.sql`:

```sql
-- Capture facts from the tools agents and flows already call.
--
-- Consent columns default to off/empty: no third-party data is captured on a
-- workspace's behalf until an admin opts in.

ALTER TABLE "organizations" ADD COLUMN "captureEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "organizations" ADD COLUMN "captureProviders" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "captured_facts" (
  "id" TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "provider" TEXT NOT NULL,
  "tool" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "props" JSONB NOT NULL DEFAULT '{}',
  "accountId" TEXT,
  "opportunityId" TEXT,
  "runId" TEXT,
  "capturedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "captured_facts_pkey" PRIMARY KEY ("id")
);

-- Re-observing the same record across runs updates one row rather than
-- accumulating one per run.
CREATE UNIQUE INDEX "captured_facts_organizationId_provider_externalId_key"
  ON "captured_facts"("organizationId", "provider", "externalId");
CREATE INDEX "captured_facts_organizationId_capturedAt_idx"
  ON "captured_facts"("organizationId", "capturedAt");
CREATE INDEX "captured_facts_organizationId_accountId_idx"
  ON "captured_facts"("organizationId", "accountId");

ALTER TABLE "captured_facts"
  ADD CONSTRAINT "captured_facts_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 5: Register with the tenant guard**

In `src/lib/tenant-guard.ts`, extend the `ORG_SCOPED_MODELS` line that lists `'CatalogueSubmission'`:

```ts
  'TemplateProposal', 'StoredFile', 'CatalogueSubmission', 'CapturedFact',
```

- [ ] **Step 6: Migrate, generate, and run**

Run: `DATABASE_URL=<your-db-url> DIRECT_URL=<your-db-url> npx prisma migrate deploy && npx prisma generate`
Then: `TEST_DATABASE_URL=<your-db-url> TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/__tests__/capture-schema.db.test.ts`
Expected: PASS, 4 tests.

Then: `npm run typecheck && npm run lint` — clean.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/tenant-guard.ts src/lib/__tests__/capture-schema.db.test.ts
git commit -m "feat(capture): store extracted facts and an org consent switch"
```

---

### Task 2: Extractors

**Files:**
- Create: `src/lib/capture/types.ts`
- Create: `src/lib/capture/extractors/jira.ts`
- Create: `src/lib/capture/extractors/zendesk.ts`
- Create: `src/lib/capture/extractors/linear.ts`
- Create: `src/lib/capture/extractors/index.ts`
- Test: `src/lib/capture/__tests__/extractors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ExtractedFact = { kind: string; externalId: string; text: string; props: Record<string, unknown> }`
  - `type Extractor = (response: unknown) => ExtractedFact[]`
  - `extractFacts(tool: string, response: unknown): ExtractedFact[]` — returns `[]` for an unknown tool.
  - `CAPTURE_TOOLS: ReadonlySet<string>` — the read tools capture applies to.
  - `CAPTURE_PROVIDERS: readonly string[]` — the bare provider keys capture supports, sorted.

- [ ] **Step 1: Write the failing test**

Create `src/lib/capture/__tests__/extractors.test.ts`. The fixtures mirror the real API shapes wired in `src/lib/nango/provider-tools.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractFacts, CAPTURE_TOOLS, CAPTURE_PROVIDERS } from '../extractors'

// Shape of /rest/api/3/search/jql with fields=summary,status,assignee,updated,issuetype
const jiraResponse = {
  issues: [
    {
      key: 'ACME-14',
      fields: {
        summary: 'SSO login fails for Okta users',
        status: { name: 'In Progress' },
        assignee: { displayName: 'Rin Takahashi' },
        updated: '2026-07-28T10:00:00.000Z',
        issuetype: { name: 'Bug' },
      },
    },
  ],
}

// Shape of /api/v2/tickets.json
const zendeskResponse = {
  tickets: [
    {
      id: 4821,
      subject: 'Cannot export reports',
      status: 'open',
      priority: 'urgent',
      updated_at: '2026-07-28T09:30:00Z',
      url: 'https://acme.zendesk.com/api/v2/tickets/4821.json',
    },
  ],
}

// Shape of the linear_list_issues GraphQL query
const linearResponse = {
  data: {
    issues: {
      nodes: [
        {
          id: 'uuid-1',
          identifier: 'ENG-92',
          title: 'Rate limit on bulk import',
          state: { name: 'Todo' },
          assignee: { name: 'Sam Okafor' },
          updatedAt: '2026-07-27T18:00:00Z',
        },
      ],
    },
  },
}

test('a Jira issue becomes one fact keyed by its issue key', () => {
  const [fact] = extractFacts('jira_list_issues', jiraResponse)
  assert.equal(fact.kind, 'issue')
  assert.equal(fact.externalId, 'ACME-14')
  assert.match(fact.text, /ACME-14/)
  assert.match(fact.text, /SSO login fails/)
  assert.equal(fact.props.status, 'In Progress')
  assert.equal(fact.props.assignee, 'Rin Takahashi')
})

test('a Zendesk ticket becomes one fact keyed by its id', () => {
  const [fact] = extractFacts('zendesk_list_tickets', zendeskResponse)
  assert.equal(fact.kind, 'ticket')
  assert.equal(fact.externalId, '4821')
  assert.match(fact.text, /Cannot export reports/)
  assert.equal(fact.props.priority, 'urgent')
})

test('a Linear issue becomes one fact keyed by its identifier', () => {
  const [fact] = extractFacts('linear_list_issues', linearResponse)
  assert.equal(fact.kind, 'issue')
  assert.equal(fact.externalId, 'ENG-92')
  assert.equal(fact.props.state, 'Todo')
})

test('a malformed response yields no facts rather than throwing', () => {
  for (const bad of [null, undefined, {}, { issues: 'nope' }, { issues: [{}] }, 'text']) {
    assert.doesNotThrow(() => extractFacts('jira_list_issues', bad))
    assert.deepEqual(extractFacts('jira_list_issues', bad), [])
  }
})

test('an unknown tool yields no facts', () => {
  assert.deepEqual(extractFacts('slack_read_messages', { messages: [] }), [])
})

test('capture applies only to the three read tools', () => {
  assert.ok(CAPTURE_TOOLS.has('jira_list_issues'))
  assert.ok(CAPTURE_TOOLS.has('zendesk_list_tickets'))
  assert.ok(CAPTURE_TOOLS.has('linear_list_issues'))
  // Writes are confirmations, not data.
  assert.ok(!CAPTURE_TOOLS.has('jira_create_issue'))
})

test('providers are declared, not parsed out of tool names', () => {
  // Parsing would break the moment a provider key contains an underscore
  // (google_drive_read_file would yield 'google'), so the registry states it.
  assert.deepEqual([...CAPTURE_PROVIDERS], ['jira', 'linear', 'zendesk'])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/capture/__tests__/extractors.test.ts`
Expected: FAIL — `Cannot find module '../extractors'`.

- [ ] **Step 3: Write the shared types**

Create `src/lib/capture/types.ts`:

```ts
/**
 * The capture layer's vocabulary.
 *
 * An ExtractedFact is what survives a tool response: enough to be searchable
 * and to be re-identified later, and nothing else. The raw response is never
 * persisted — see the spec's non-goals.
 */

export interface ExtractedFact {
  /** Extractor-defined shape, e.g. 'issue' | 'ticket'. */
  kind: string
  /** Stable id in the SOURCE system; dedupes re-capture across runs. */
  externalId: string
  /** Human-readable summary; this is what gets embedded for retrieval. */
  text: string
  /** Typed attributes rendered into context: status, priority, assignee, url. */
  props: Record<string, unknown>
}

export type Extractor = (response: unknown) => ExtractedFact[]

/** Narrow an unknown value to an array of plain objects; [] for anything else. */
export function rowsOf(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
}

/** Read a string field, or '' when absent/wrong-typed. */
export function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
}

/** Read a nested `{ name }` / `{ displayName }` label, or ''. */
export function label(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const obj = value as Record<string, unknown>
  return text(obj.displayName) || text(obj.name)
}
```

- [ ] **Step 4: Write the three extractors**

Create `src/lib/capture/extractors/jira.ts`:

```ts
/**
 * Jira issues from `jira_list_issues`, which calls /rest/api/3/search/jql with
 * fields=summary,status,assignee,updated,issuetype (see provider-tools.ts).
 */
import { label, rowsOf, text, type ExtractedFact, type Extractor } from '../types'

export const extractJiraIssues: Extractor = (response) => {
  const body = (response ?? {}) as Record<string, unknown>
  return rowsOf(body.issues).flatMap((issue): ExtractedFact[] => {
    const key = text(issue.key)
    if (!key) return []
    const fields = (issue.fields ?? {}) as Record<string, unknown>
    const summary = text(fields.summary)
    const status = label(fields.status)
    return [{
      kind: 'issue',
      externalId: key,
      text: [key, summary, status && `— ${status}`].filter(Boolean).join(': ').replace(': —', ' —'),
      props: {
        summary,
        status,
        assignee: label(fields.assignee),
        issueType: label(fields.issuetype),
        updatedAt: text(fields.updated),
      },
    }]
  })
}
```

Create `src/lib/capture/extractors/zendesk.ts`:

```ts
/** Zendesk tickets from `zendesk_list_tickets` (/api/v2/tickets.json). */
import { rowsOf, text, type ExtractedFact, type Extractor } from '../types'

export const extractZendeskTickets: Extractor = (response) => {
  const body = (response ?? {}) as Record<string, unknown>
  return rowsOf(body.tickets).flatMap((ticket): ExtractedFact[] => {
    const id = text(ticket.id)
    if (!id) return []
    const subject = text(ticket.subject)
    const status = text(ticket.status)
    return [{
      kind: 'ticket',
      externalId: id,
      text: [`Ticket ${id}`, subject, status && `— ${status}`].filter(Boolean).join(': ').replace(': —', ' —'),
      props: {
        subject,
        status,
        priority: text(ticket.priority),
        url: text(ticket.url),
        updatedAt: text(ticket.updated_at),
      },
    }]
  })
}
```

Create `src/lib/capture/extractors/linear.ts`:

```ts
/**
 * Linear issues from `linear_list_issues`, a GraphQL query returning
 * data.issues.nodes with { id, identifier, title, state, assignee, updatedAt }.
 */
import { label, rowsOf, text, type ExtractedFact, type Extractor } from '../types'

export const extractLinearIssues: Extractor = (response) => {
  const body = (response ?? {}) as Record<string, unknown>
  const data = (body.data ?? {}) as Record<string, unknown>
  const issues = (data.issues ?? {}) as Record<string, unknown>
  return rowsOf(issues.nodes).flatMap((issue): ExtractedFact[] => {
    // Prefer the human identifier (ENG-92); fall back to the uuid.
    const identifier = text(issue.identifier) || text(issue.id)
    if (!identifier) return []
    const title = text(issue.title)
    const state = label(issue.state)
    return [{
      kind: 'issue',
      externalId: identifier,
      text: [identifier, title, state && `— ${state}`].filter(Boolean).join(': ').replace(': —', ' —'),
      props: {
        title,
        state,
        assignee: label(issue.assignee),
        updatedAt: text(issue.updatedAt),
      },
    }]
  })
}
```

Create `src/lib/capture/extractors/index.ts`:

```ts
/**
 * The extractor registry: which tools produce facts, and how.
 *
 * Only READ tools appear here. A write tool's response is a confirmation that
 * something happened, not data about the customer, so capturing it would store
 * noise. Adding a provider is one entry plus one pure function.
 */
import type { Extractor, ExtractedFact } from '../types'
import { extractJiraIssues } from './jira'
import { extractZendeskTickets } from './zendesk'
import { extractLinearIssues } from './linear'

interface Registration {
  /** Bare Nango provider key. Declared, never parsed out of the tool name —
   *  splitting on '_' would read 'google_drive_read_file' as 'google'. */
  provider: string
  extract: Extractor
}

const EXTRACTORS: Record<string, Registration> = {
  jira_list_issues: { provider: 'jira', extract: extractJiraIssues },
  zendesk_list_tickets: { provider: 'zendesk', extract: extractZendeskTickets },
  linear_list_issues: { provider: 'linear', extract: extractLinearIssues },
}

export const CAPTURE_TOOLS: ReadonlySet<string> = new Set(Object.keys(EXTRACTORS))

/** The provider keys a workspace may enable capture for. */
export const CAPTURE_PROVIDERS: readonly string[] =
  [...new Set(Object.values(EXTRACTORS).map((entry) => entry.provider))].sort()

/**
 * Extract facts from a tool response. Returns [] for an unknown tool and for
 * any malformed response — extraction never throws into the caller, because a
 * capture failure must not fail the run that triggered it.
 */
export function extractFacts(tool: string, response: unknown): ExtractedFact[] {
  const registration = EXTRACTORS[tool]
  if (!registration) return []
  try {
    return registration.extract(response)
  } catch {
    return []
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/capture/__tests__/extractors.test.ts`
Expected: PASS, 6 tests.

Then: `npm run typecheck && npm run lint` — clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/capture
git commit -m "feat(capture): turn Jira, Zendesk, and Linear responses into facts"
```

---

### Task 3: The resolution ladder

**Files:**
- Create: `src/lib/capture/resolve.ts`
- Test: `src/lib/capture/__tests__/resolve.test.ts`

**Interfaces:**
- Consumes: `ExtractedFact` (Task 2).
- Produces:
  - `type ResolutionContext = { signalAccountId?: string | null; signalOpportunityId?: string | null }`
  - `type SalesAiLookup = { findByCrmId(id: string): Promise<{ accountId?: string | null; opportunityId?: string | null } | null>; findAccountByName(name: string): Promise<string | null> }`
  - `resolveFactTarget(fact: ExtractedFact, ctx: ResolutionContext, lookup: SalesAiLookup | null): Promise<{ accountId: string | null; opportunityId: string | null }>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/capture/__tests__/resolve.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveFactTarget } from '../resolve'
import type { ExtractedFact } from '../types'

const fact = (props: Record<string, unknown> = {}): ExtractedFact => ({
  kind: 'issue', externalId: 'ACME-14', text: 'ACME-14: something', props,
})

const neverCalled = {
  async findByCrmId() { throw new Error('must not be called') },
  async findAccountByName() { throw new Error('must not be called') },
}

test('run context wins and costs no lookup', async () => {
  const result = await resolveFactTarget(
    fact({ crmId: '0016000001', organization: 'Acme' }),
    { signalAccountId: 'acct-1', signalOpportunityId: 'opp-1' },
    neverCalled,
  )
  assert.deepEqual(result, { accountId: 'acct-1', opportunityId: 'opp-1' })
})

test('a CRM id in the props resolves when there is no run context', async () => {
  const result = await resolveFactTarget(fact({ crmId: '0016000001' }), {}, {
    async findByCrmId(id) {
      assert.equal(id, '0016000001')
      return { accountId: 'acct-2', opportunityId: null }
    },
    async findAccountByName() { throw new Error('must not reach the name strategy') },
  })
  assert.equal(result.accountId, 'acct-2')
})

test('an account name resolves only after the CRM id misses', async () => {
  const result = await resolveFactTarget(fact({ organization: 'Acme Corp' }), {}, {
    async findByCrmId() { return null },
    async findAccountByName(name) {
      assert.equal(name, 'Acme Corp')
      return 'acct-3'
    },
  })
  assert.equal(result.accountId, 'acct-3')
})

test('nothing resolvable leaves the fact unlinked rather than guessing', async () => {
  const result = await resolveFactTarget(fact({ summary: 'Login is broken' }), {}, {
    async findByCrmId() { return null },
    async findAccountByName() { return null },
  })
  assert.deepEqual(result, { accountId: null, opportunityId: null })
})

test('a lookup failure leaves the fact unlinked instead of throwing', async () => {
  const result = await resolveFactTarget(fact({ crmId: 'x' }), {}, {
    async findByCrmId() { throw new Error('People.ai unreachable') },
    async findAccountByName() { throw new Error('People.ai unreachable') },
  })
  assert.deepEqual(result, { accountId: null, opportunityId: null })
})

test('with no Sales AI client at all, only run context can resolve', async () => {
  assert.deepEqual(
    await resolveFactTarget(fact({ crmId: 'x' }), {}, null),
    { accountId: null, opportunityId: null },
  )
  assert.deepEqual(
    await resolveFactTarget(fact(), { signalAccountId: 'acct-9' }, null),
    { accountId: 'acct-9', opportunityId: null },
  )
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/capture/__tests__/resolve.test.ts`
Expected: FAIL — `Cannot find module '../resolve'`.

- [ ] **Step 3: Write the ladder**

Create `src/lib/capture/resolve.ts`:

```ts
/**
 * Deciding which account a captured fact belongs to.
 *
 * Ordered most-deterministic-first, and it stops at the first hit. The last
 * resort is NOT a guess: when nothing resolves the fact is stored unlinked.
 * A wrong edge silently poisons retrieval for that account — the fact would
 * surface against the wrong customer — whereas a missing edge merely means it
 * does not surface yet. A later observation of the same externalId can resolve
 * it, since the row is keyed on that.
 */
import type { ExtractedFact } from './types'

export interface ResolutionContext {
  /** From the signal that triggered the run — exact, free, and most common. */
  signalAccountId?: string | null
  signalOpportunityId?: string | null
}

export interface SalesAiLookup {
  findByCrmId(id: string): Promise<{ accountId?: string | null; opportunityId?: string | null } | null>
  findAccountByName(name: string): Promise<string | null>
}

export interface ResolvedTarget {
  accountId: string | null
  opportunityId: string | null
}

/** Props that plausibly carry a CRM record id, in preference order. */
const CRM_ID_KEYS = ['crmId', 'crm_id', 'accountId', 'salesforceId']
/** Props that plausibly carry a customer/company name. */
const NAME_KEYS = ['organization', 'organisation', 'company', 'accountName']

function firstString(props: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = props[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

export async function resolveFactTarget(
  fact: ExtractedFact,
  ctx: ResolutionContext,
  lookup: SalesAiLookup | null,
): Promise<ResolvedTarget> {
  // 1. Run context. The run was started BECAUSE of this account, so this is the
  //    strongest signal available and it costs nothing.
  if (ctx.signalAccountId || ctx.signalOpportunityId) {
    return {
      accountId: ctx.signalAccountId ?? null,
      opportunityId: ctx.signalOpportunityId ?? null,
    }
  }

  if (!lookup) return { accountId: null, opportunityId: null }

  // 2 and 3 cost a People.ai round-trip, so they run only on a miss. A lookup
  // failure is not retried inline — an unlinked fact is the correct outcome.
  try {
    const crmId = firstString(fact.props, CRM_ID_KEYS)
    if (crmId) {
      const hit = await lookup.findByCrmId(crmId)
      if (hit?.accountId || hit?.opportunityId) {
        return { accountId: hit.accountId ?? null, opportunityId: hit.opportunityId ?? null }
      }
    }

    const name = firstString(fact.props, NAME_KEYS)
    if (name) {
      const accountId = await lookup.findAccountByName(name)
      if (accountId) return { accountId, opportunityId: null }
    }
  } catch {
    // Fall through to unlinked.
  }

  return { accountId: null, opportunityId: null }
}
```

- [ ] **Step 4: Run the tests**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/capture/__tests__/resolve.test.ts`
Expected: PASS, 6 tests.

Then: `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/capture/resolve.ts src/lib/capture/__tests__/resolve.test.ts
git commit -m "feat(capture): resolve facts to accounts, or leave them unlinked"
```

---

### Task 4: The capture service and its two call sites

**Files:**
- Create: `src/lib/capture/capture.ts`
- Modify: `src/features/agents/execute-agent.ts` (after the tool result at ~line 1073)
- Modify: `src/features/flows/execute-flow.ts` (after `executor.execute(...)` at ~line 713)
- Test: `src/lib/capture/__tests__/capture.db.test.ts`

**Interfaces:**
- Consumes: `extractFacts`, `CAPTURE_TOOLS` (Task 2); `resolveFactTarget`, `SalesAiLookup` (Task 3); `CapturedFact`, consent columns (Task 1).
- Produces: `captureToolResult(input: CaptureInput): Promise<void>` where
  `CaptureInput = { organizationId: string; userId: string; provider: string; tool: string; isWrite: boolean; result: unknown; runId?: string | null; signalAccountId?: string | null; signalOpportunityId?: string | null }`.
  Never throws.

- [ ] **Step 1: Write the failing test**

Create `src/lib/capture/__tests__/capture.db.test.ts`:

```ts
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let captureToolResult: any
  let orgId: string

  const jiraResponse = {
    issues: [{
      key: 'ACME-14',
      fields: { summary: 'SSO login fails', status: { name: 'In Progress' }, updated: '2026-07-28T10:00:00.000Z' },
    }],
  }

  const input = (overrides: Record<string, unknown> = {}) => ({
    organizationId: orgId,
    userId: 'user-1',
    provider: 'nango:jira',
    tool: 'jira_list_issues',
    isWrite: false,
    result: jiraResponse,
    ...overrides,
  })

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ captureToolResult } = await import('../capture'))
    const org = await prisma.organization.create({
      data: { name: 'cap', slug: `cap-${crypto.randomUUID()}` },
    })
    orgId = org.id
  })

  after(async () => {
    if (orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => {})
  })

  beforeEach(async () => {
    await prisma.capturedFact.deleteMany({ where: { organizationId: orgId } })
  })

  const enable = (providers: string[]) =>
    prisma.organization.update({
      where: { id: orgId },
      data: { captureEnabled: providers.length > 0, captureProviders: providers },
    })

  test('capture disabled writes nothing', async () => {
    await enable([])
    await captureToolResult(input())
    assert.equal(await prisma.capturedFact.count({ where: { organizationId: orgId } }), 0)
  })

  test('enabled but provider not allowed writes nothing', async () => {
    await enable(['zendesk'])
    await captureToolResult(input())
    assert.equal(await prisma.capturedFact.count({ where: { organizationId: orgId } }), 0)
  })

  test('an allowed provider captures the fact', async () => {
    await enable(['jira'])
    await captureToolResult(input({ runId: 'run-1' }))
    const rows = await prisma.capturedFact.findMany({ where: { organizationId: orgId } })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].externalId, 'ACME-14')
    assert.equal(rows[0].provider, 'jira', 'the nango: prefix is stripped to the bare provider key')
    assert.equal(rows[0].runId, 'run-1')
    assert.ok(rows[0].expiresAt > new Date())
  })

  test('run context resolves the account without any Sales AI call', async () => {
    await enable(['jira'])
    await captureToolResult(input({ signalAccountId: 'acct-7' }))
    const row = await prisma.capturedFact.findFirst({ where: { organizationId: orgId } })
    assert.equal(row.accountId, 'acct-7')
  })

  test('write tools are never captured', async () => {
    await enable(['jira'])
    await captureToolResult(input({ tool: 'jira_create_issue', isWrite: true }))
    assert.equal(await prisma.capturedFact.count({ where: { organizationId: orgId } }), 0)
  })

  test('re-observing the same issue updates the existing row', async () => {
    await enable(['jira'])
    await captureToolResult(input())
    await captureToolResult(input({
      result: { issues: [{ key: 'ACME-14', fields: { summary: 'SSO login fails', status: { name: 'Done' } } }] },
    }))
    const rows = await prisma.capturedFact.findMany({ where: { organizationId: orgId } })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].props.status, 'Done')
  })

  test('a malformed response never throws', async () => {
    await enable(['jira'])
    await assert.doesNotReject(() => captureToolResult(input({ result: 'not json' })))
    assert.equal(await prisma.capturedFact.count({ where: { organizationId: orgId } }), 0)
  })

  test('revoking consent stops the next capture with no restart', async () => {
    await enable(['jira'])
    await captureToolResult(input())
    await enable([])
    await captureToolResult(input({ result: { issues: [{ key: 'ACME-99', fields: { summary: 'later' } }] } }))
    const rows = await prisma.capturedFact.findMany({ where: { organizationId: orgId } })
    assert.equal(rows.length, 1, 'consent is read fresh, not cached')
    assert.equal(rows[0].externalId, 'ACME-14')
  })
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL=<your-db-url> TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/capture/__tests__/capture.db.test.ts`
Expected: FAIL — `Cannot find module '../capture'`.

- [ ] **Step 3: Write the capture service**

Create `src/lib/capture/capture.ts`:

```ts
/**
 * The capture entry point, called from the agent and flow run loops after a
 * successful external tool call.
 *
 * Contract: this NEVER throws and NEVER changes the caller's result. Capture is
 * a side benefit of work the user already asked for; a bug here must not fail
 * their run. Every failure logs and returns.
 */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { CAPTURE_TOOLS, extractFacts } from './extractors'
import { resolveFactTarget, type SalesAiLookup } from './resolve'

export interface CaptureInput {
  organizationId: string
  userId: string
  /** Runtime provider id, e.g. 'nango:jira' — normalized below. */
  provider: string
  tool: string
  isWrite: boolean
  result: unknown
  runId?: string | null
  signalAccountId?: string | null
  signalOpportunityId?: string | null
}

/** Retention window for captured facts. */
const RETENTION_DAYS = Number(process.env.CAPTURE_RETENTION_DAYS) || 90
/** Bound on facts written per call, so one huge list can't flood the table. */
const MAX_FACTS_PER_CALL = 50

/** 'nango:jira' → 'jira'. Consent is expressed in bare provider keys. */
export function bareProvider(provider: string): string {
  return provider.includes(':') ? provider.slice(provider.indexOf(':') + 1) : provider
}

export async function captureToolResult(input: CaptureInput): Promise<void> {
  try {
    // Writes are confirmations, not data.
    if (input.isWrite) return
    if (!CAPTURE_TOOLS.has(input.tool)) return

    const provider = bareProvider(input.provider)

    // Consent is read FRESH on every capture, never cached: a cache would mean
    // a workspace that revokes consent keeps having data captured until the TTL
    // expired, which is the one behavior this setting exists to prevent.
    const org = await prisma.organization.findUnique({
      where: { id: input.organizationId },
      select: { captureEnabled: true, captureProviders: true },
    })
    if (!org?.captureEnabled) return
    if (!org.captureProviders.includes(provider)) return

    const facts = extractFacts(input.tool, input.result).slice(0, MAX_FACTS_PER_CALL)
    if (facts.length === 0) return

    const lookup = await salesAiLookup(input.organizationId, input.userId)
    const expiresAt = new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000)

    for (const fact of facts) {
      const target = await resolveFactTarget(
        fact,
        { signalAccountId: input.signalAccountId, signalOpportunityId: input.signalOpportunityId },
        lookup,
      )
      await prisma.capturedFact.upsert({
        where: {
          organizationId_provider_externalId: {
            organizationId: input.organizationId,
            provider,
            externalId: fact.externalId,
          },
        },
        create: {
          organizationId: input.organizationId,
          provider,
          tool: input.tool,
          kind: fact.kind,
          externalId: fact.externalId,
          text: fact.text,
          props: fact.props as never,
          accountId: target.accountId,
          opportunityId: target.opportunityId,
          runId: input.runId ?? null,
          expiresAt,
        },
        update: {
          text: fact.text,
          props: fact.props as never,
          // Only ever ADD linkage: a later observation without run context must
          // not unlink a fact an earlier one resolved.
          ...(target.accountId ? { accountId: target.accountId } : {}),
          ...(target.opportunityId ? { opportunityId: target.opportunityId } : {}),
          runId: input.runId ?? null,
          capturedAt: new Date(),
          expiresAt,
        },
      })
    }
  } catch (error) {
    apiLogger.warn('capture failed', {
      tool: input.tool,
      organizationId: input.organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * A Sales AI lookup backed by the caller's People.ai connection, or null when
 * the workspace has none. Resolution degrades to run-context-only in that case.
 */
async function salesAiLookup(organizationId: string, userId: string): Promise<SalesAiLookup | null> {
  const { getPeopleAiClientForUser, getPeopleAiServiceClient } = await import('@/lib/peopleai/client')
  const client = (await getPeopleAiClientForUser(userId, organizationId)) ?? getPeopleAiServiceClient()
  if (!client) return null
  return {
    async findByCrmId(id) {
      const result = (await client.callTool('find_record_by_crm_id', { crm_id: id })) as Record<string, unknown> | null
      if (!result) return null
      return {
        accountId: typeof result.account_id === 'string' ? result.account_id : null,
        opportunityId: typeof result.opportunity_id === 'string' ? result.opportunity_id : null,
      }
    },
    async findAccountByName(name) {
      const result = (await client.callTool('find_account', { account_name: name })) as Record<string, unknown> | null
      return typeof result?.account_id === 'string' ? result.account_id : null
    },
  }
}
```

- [ ] **Step 4: Run the service tests**

Run: `TEST_DATABASE_URL=<your-db-url> TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/capture/__tests__/capture.db.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Wire the agent run loop**

In `src/features/agents/execute-agent.ts`, add the import at the top:

```ts
import { captureToolResult } from '@/lib/capture/capture'
```

Immediately after the successful tool result is recorded (the `recordAudit` call that follows `const result = await binding.client.executeTool(...)`), add:

```ts
          // Capture, fire-and-forget: extracts facts from READ tools when the
          // workspace has opted in. Never awaited into the run's critical path
          // and never able to fail it — see src/lib/capture/capture.ts.
          void captureToolResult({
            organizationId,
            userId,
            provider: binding.provider,
            tool: binding.toolName,
            isWrite: binding.isWrite,
            result,
            runId: execution.id,
            signalAccountId: signal?.accountId ?? null,
            signalOpportunityId: signal?.opportunityId ?? null,
          })
```

The `signal` binding already exists in this scope — `indexExecution` reads the same `execution.input.signal` shape. If it is not in scope at this point, derive it the same way immediately above the call:

```ts
          const signal = (execution.input as { signal?: { accountId?: string; opportunityId?: string } } | null)?.signal
```

- [ ] **Step 6: Wire the flow run loop**

In `src/features/flows/execute-flow.ts`, add the import:

```ts
import { captureToolResult } from '@/lib/capture/capture'
```

After the tool step's output is produced (following the `runWithRetries` call that wraps `executor.execute(toolName, args)`), add:

```ts
        // Capture, fire-and-forget. Same contract as the agent path.
        void captureToolResult({
          organizationId: job.organizationId,
          userId: job.userId,
          provider: executor.provider,
          tool: toolName,
          isWrite: executor.isWrite,
          result: output,
          runId: run.id,
        })
```

Flows carry no triggering signal in this scope, so account resolution falls to the CRM-id and name strategies — which is exactly why the ladder has them.

- [ ] **Step 7: Run the full suite**

Run: `TEST_DATABASE_URL=<your-db-url> npm test`
Expected: PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/capture src/features/agents/execute-agent.ts src/features/flows/execute-flow.ts
git commit -m "feat(capture): record facts from read tools as runs execute"
```

---

### Task 5: Consent and deletion

**Files:**
- Create: `src/app/api/capture/settings/route.ts`
- Create: `src/components/integrations/capture-settings.tsx`
- Modify: `src/app/integrations/page.tsx` (mount the component)
- Modify: `src/app/api/__tests__/route-smoke.test.ts` (add the GET case)
- Test: `src/app/api/capture/__tests__/settings.db.test.ts`

**Interfaces:**
- Consumes: consent columns (Task 1); `integration.manage` permission from the RBAC registry (`src/lib/authz/permissions.ts`).
- Produces: `GET /api/capture/settings`, `PATCH /api/capture/settings`, `DELETE /api/capture/settings`.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/capture/__tests__/settings.db.test.ts`:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let installTestAuth: any
  let admin: any
  let member: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    installTestAuth = testAuth.installTestAuth
    admin = await testAuth.seedTestOrg(prisma, { role: 'ADMIN' })
    member = await testAuth.seedTestOrg(prisma, { role: 'USER' })
  })

  after(async () => {
    if (member) await member.cleanup()
    if (admin) await admin.cleanup()
  })

  const patch = (body: unknown) =>
    new NextRequest(new URL('http://test/api/capture/settings'), {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    })

  test('an ordinary member cannot change capture settings', async () => {
    installTestAuth(member.auth)
    const { PATCH } = await import('../settings/route')
    const response = await PATCH(patch({ captureEnabled: true, captureProviders: ['jira'] }))
    assert.equal(response.status, 403)
    assert.equal((await response.json()).code, 'PERMISSION_DENIED')
  })

  test('an admin turns capture on for named providers', async () => {
    installTestAuth(admin.auth)
    const { PATCH } = await import('../settings/route')
    const response = await PATCH(patch({ captureEnabled: true, captureProviders: ['jira', 'zendesk'] }))
    assert.equal(response.status, 200)
    const org = await prisma.organization.findUnique({ where: { id: admin.organizationId } })
    assert.equal(org.captureEnabled, true)
    assert.deepEqual(org.captureProviders, ['jira', 'zendesk'])
  })

  test('an unsupported provider is rejected rather than silently stored', async () => {
    installTestAuth(admin.auth)
    const { PATCH } = await import('../settings/route')
    const response = await PATCH(patch({ captureEnabled: true, captureProviders: ['mystery'] }))
    assert.equal(response.status, 400)
  })

  test('settings report which providers can be captured', async () => {
    installTestAuth(admin.auth)
    const { GET } = await import('../settings/route')
    const response = await GET(new NextRequest(new URL('http://test/api/capture/settings')))
    const body = await response.json()
    assert.deepEqual(body.available.sort(), ['jira', 'linear', 'zendesk'])
    assert.equal(body.captureEnabled, true)
  })

  test('turning capture off does not delete existing facts', async () => {
    await prisma.capturedFact.create({
      data: {
        organizationId: admin.organizationId, provider: 'jira', tool: 'jira_list_issues',
        kind: 'issue', externalId: 'K-1', text: 't', expiresAt: new Date(Date.now() + 86_400_000),
      },
    })
    installTestAuth(admin.auth)
    const { PATCH } = await import('../settings/route')
    await PATCH(patch({ captureEnabled: false, captureProviders: [] }))
    assert.equal(await prisma.capturedFact.count({ where: { organizationId: admin.organizationId } }), 1)
  })

  test('deletion is explicit and removes the workspace facts', async () => {
    installTestAuth(admin.auth)
    const { DELETE } = await import('../settings/route')
    const response = await DELETE(new NextRequest(new URL('http://test/api/capture/settings'), { method: 'DELETE' }))
    assert.equal(response.status, 200)
    assert.equal(await prisma.capturedFact.count({ where: { organizationId: admin.organizationId } }), 0)
  })

  test('an ordinary member cannot delete captured data', async () => {
    installTestAuth(member.auth)
    const { DELETE } = await import('../settings/route')
    const response = await DELETE(new NextRequest(new URL('http://test/api/capture/settings'), { method: 'DELETE' }))
    assert.equal(response.status, 403)
  })
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL=<your-db-url> TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/capture/__tests__/settings.db.test.ts`
Expected: FAIL — `Cannot find module '../settings/route'`.

- [ ] **Step 3: Write the route**

Create `src/app/api/capture/settings/route.ts`:

```ts
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordAudit } from '@/lib/audit'
import { CAPTURE_PROVIDERS } from '@/lib/capture/extractors'
import { bareProvider } from '@/lib/capture/capture'

/** Providers with an extractor — the only ones capture can be enabled for. */
const AVAILABLE_PROVIDERS = CAPTURE_PROVIDERS

const settingsSchema = z.object({
  captureEnabled: z.boolean(),
  captureProviders: z.array(z.string()).max(32),
})

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const org = await prisma.organization.findUnique({
    where: { id: auth.organizationId },
    select: { captureEnabled: true, captureProviders: true },
  })
  const capturedCount = await prisma.capturedFact.count({ where: { organizationId: auth.organizationId } })
  return {
    success: true,
    captureEnabled: org?.captureEnabled ?? false,
    captureProviders: org?.captureProviders ?? [],
    available: AVAILABLE_PROVIDERS,
    capturedCount,
  }
}, { permission: 'integration.manage' })

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const data = settingsSchema.parse(await request.json())
  // Reject an unknown provider rather than storing a key nothing can act on —
  // a silently-ignored setting reads as "capture is on" when it never runs.
  const providers = data.captureProviders.map(bareProvider)
  const unsupported = providers.filter((provider) => !AVAILABLE_PROVIDERS.includes(provider))
  if (unsupported.length) {
    const { ApiError } = await import('@/lib/server/api-handler')
    throw new ApiError(
      `Capture is not available for ${unsupported.join(', ')}. Supported: ${AVAILABLE_PROVIDERS.join(', ')}.`,
      400,
      'UNSUPPORTED_PROVIDER',
    )
  }

  await prisma.organization.update({
    where: { id: auth.organizationId },
    data: { captureEnabled: data.captureEnabled, captureProviders: providers },
  })
  await recordAudit({
    organizationId: auth.organizationId,
    action: 'capture.settings_changed',
    actorUserId: auth.dbUser.id,
    detail: { captureEnabled: data.captureEnabled, captureProviders: providers },
  })
  return { success: true }
}, { permission: 'integration.manage' })

// Explicit deletion. Turning capture OFF deliberately does not delete: an admin
// stopping collection should not silently destroy the enrichment their
// workspace already relies on.
export const DELETE = withAuthenticatedApi(async (_request, auth) => {
  const { count } = await prisma.capturedFact.deleteMany({ where: { organizationId: auth.organizationId } })
  await recordAudit({
    organizationId: auth.organizationId,
    action: 'capture.data_deleted',
    actorUserId: auth.dbUser.id,
    detail: { deleted: count },
  })
  return { success: true, deleted: count }
}, { permission: 'integration.manage' })
```

- [ ] **Step 4: Add the smoke case**

In `src/app/api/__tests__/route-smoke.test.ts`, add to the `cases` array:

```ts
    { name: 'GET /api/capture/settings', run: async () => (await import('../capture/settings/route')).GET(req('/api/capture/settings')) },
```

- [ ] **Step 5: Build the settings UI**

Create `src/components/integrations/capture-settings.tsx`:

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'

const PROVIDER_LABELS: Record<string, string> = {
  jira: 'Jira',
  zendesk: 'Zendesk',
  linear: 'Linear',
}

interface Settings {
  captureEnabled: boolean
  captureProviders: string[]
  available: string[]
  capturedCount: number
}

export function CaptureSettings() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const response = await fetch('/api/capture/settings', { cache: 'no-store' })
    if (!response.ok) return
    const body = await response.json()
    if (body.success) setSettings(body)
  }, [])

  useEffect(() => { void load() }, [load])

  async function save(next: { captureEnabled: boolean; captureProviders: string[] }) {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/capture/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
    })
    setBusy(false)
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      setError(body.error ?? 'That change could not be saved. Try again.')
      return
    }
    void load()
  }

  async function deleteAll() {
    if (!confirm('Delete every fact captured for this workspace? This cannot be undone.')) return
    setBusy(true)
    await fetch('/api/capture/settings', { method: 'DELETE' })
    setBusy(false)
    void load()
  }

  if (!settings) return null

  const toggleProvider = (provider: string) => {
    const providers = settings.captureProviders.includes(provider)
      ? settings.captureProviders.filter((entry) => entry !== provider)
      : [...settings.captureProviders, provider]
    void save({ captureEnabled: settings.captureEnabled, captureProviders: providers })
  }

  return (
    <section className="space-y-3 rounded-xl border border-border/60 p-5">
      <div>
        <h2 className="text-sm font-medium">Learn from your connected tools</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          When an agent or flow reads from these tools, we keep a short summary of what it found — issue titles,
          statuses, and links — and connect it to the right account. We never store the full response, and this is
          off until you turn it on.
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={settings.captureEnabled}
          disabled={busy}
          onChange={(event) => save({ captureEnabled: event.target.checked, captureProviders: settings.captureProviders })}
        />
        <span>Capture from connected tools</span>
      </label>

      {settings.captureEnabled && (
        <div className="flex flex-wrap gap-3 pl-6">
          {settings.available.map((provider) => (
            <label key={provider} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={settings.captureProviders.includes(provider)}
                disabled={busy}
                onChange={() => toggleProvider(provider)}
              />
              <span>{PROVIDER_LABELS[provider] ?? provider}</span>
            </label>
          ))}
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      {settings.capturedCount > 0 && (
        <div className="flex items-center justify-between border-t border-border/60 pt-3 text-xs text-muted-foreground">
          <span>{settings.capturedCount} captured {settings.capturedCount === 1 ? 'record' : 'records'}</span>
          <button type="button" onClick={deleteAll} disabled={busy} className="underline">
            Delete captured data
          </button>
        </div>
      )}
    </section>
  )
}
```

Mount it in `src/app/integrations/page.tsx` alongside the existing connection sections. Locate the page's main content container first:

Run: `grep -n "export default\|<section\|className=\"space-y" src/app/integrations/page.tsx | head`

Render `<CaptureSettings />` as a sibling section after the connected-accounts block.

- [ ] **Step 6: Run the tests**

Run: `TEST_DATABASE_URL=<your-db-url> TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/capture/__tests__/settings.db.test.ts`
Expected: PASS, 7 tests.

Run: `TEST_DATABASE_URL=<your-db-url> npm test` — full suite, including the smoke and permission-coverage guards.
Then: `npm run typecheck && npm run lint`.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/capture src/components/integrations/capture-settings.tsx src/app/integrations/page.tsx src/app/api/__tests__/route-smoke.test.ts
git commit -m "feat(capture): workspaces opt in per provider and can delete what was captured"
```

---

### Task 6: Graph enrichment

**Files:**
- Modify: `src/lib/rag/store.ts` (add `'fact'` to `NodeType`, `'captured_in'` to `EdgeRelation`)
- Create: `src/lib/capture/index-facts.ts`
- Modify: `src/lib/capture/capture.ts` (call the indexer after the upsert loop)
- Test: `src/lib/capture/__tests__/index-facts.test.ts`

**Interfaces:**
- Consumes: `commitGraph`, `nodeIds` from `src/lib/rag/indexer.ts`; `GraphEdge`, `NodeType` from `src/lib/rag/store.ts`.
- Produces: `indexCapturedFacts(organizationId: string, facts: IndexableFact[]): Promise<void>` where
  `IndexableFact = { id: string; text: string; provider: string; kind: string; externalId: string; props: Record<string, unknown>; accountId: string | null; opportunityId: string | null; runId: string | null }`.

- [ ] **Step 1: Confirm the stores are generic over NodeType**

Run: `grep -n "NodeType" src/lib/rag/neo4j-store.ts src/lib/rag/memory-store.ts`
Expected: only type annotations and a cast (`p.type as NodeType`) — no exhaustive `switch` that a new member would break. This was verified during design; confirm it still holds before changing the union.

- [ ] **Step 2: Write the failing test**

Create `src/lib/capture/__tests__/index-facts.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { factNodeId, buildFactGraph } from '../index-facts'

const fact = (overrides: Record<string, unknown> = {}) => ({
  id: 'cf1',
  text: 'ACME-14: SSO login fails — In Progress',
  provider: 'jira',
  kind: 'issue',
  externalId: 'ACME-14',
  props: { status: 'In Progress' },
  accountId: 'acct-1',
  opportunityId: null,
  runId: 'run-1',
  ...overrides,
})

test('a fact node is stable across re-capture', () => {
  assert.equal(factNodeId('jira', 'ACME-14'), factNodeId('jira', 'ACME-14'))
  assert.notEqual(factNodeId('jira', 'ACME-14'), factNodeId('linear', 'ACME-14'))
})

test('a resolved fact links to its account and its run', () => {
  const { nodes, edges } = buildFactGraph('org-1', [fact()])
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].type, 'fact')
  assert.equal(nodes[0].visibility, 'shared')

  const rels = edges.map((edge) => edge.rel).sort()
  assert.deepEqual(rels, ['about_account', 'captured_in'])
})

test('an unlinked fact still indexes, with no account edge', () => {
  const { nodes, edges } = buildFactGraph('org-1', [fact({ accountId: null, runId: null })])
  assert.equal(nodes.length, 1)
  assert.deepEqual(edges, [])
})

test('no bare account node is emitted', () => {
  // upsertNodes is a full replace, so writing a bare account node here would
  // clobber the richer shared entity node enrichEntities maintains.
  const { nodes } = buildFactGraph('org-1', [fact()])
  assert.ok(nodes.every((node) => node.type === 'fact'))
})

test('an opportunity link is emitted when resolved', () => {
  const { edges } = buildFactGraph('org-1', [fact({ opportunityId: 'opp-2' })])
  assert.ok(edges.some((edge) => edge.rel === 'about_opportunity'))
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/capture/__tests__/index-facts.test.ts`
Expected: FAIL — `Cannot find module '../index-facts'`.

- [ ] **Step 4: Extend the graph vocabulary**

In `src/lib/rag/store.ts`, add `'fact'` to the `NodeType` union:

```ts
export type NodeType =
  | 'account'
  | 'opportunity'
  | 'stakeholder'
  | 'signal'
  | 'agent'
  | 'run'
  | 'insight'
  /// A record observed in a connected tool (Jira issue, Zendesk ticket) during
  /// a run. See src/lib/capture/.
  | 'fact'
```

Add `'captured_in'` to `EdgeRelation`:

```ts
  | 'captured_in' // fact → the run that observed it
```

- [ ] **Step 5: Write the indexer**

Create `src/lib/capture/index-facts.ts`:

```ts
/**
 * Putting captured facts on the graph so retrieval can correlate them with the
 * accounts and opportunities everything else already hangs off.
 */
import { commitGraph, nodeIds } from '@/lib/rag/indexer'
import { apiLogger } from '@/lib/logger'
import type { GraphEdge } from '@/lib/rag/store'

export interface IndexableFact {
  id: string
  text: string
  provider: string
  kind: string
  externalId: string
  props: Record<string, unknown>
  accountId: string | null
  opportunityId: string | null
  runId: string | null
}

/** Stable node id, so re-capturing the same record upserts in place. */
export function factNodeId(provider: string, externalId: string): string {
  return `fact:${provider}:${externalId}`
}

interface PendingFactNode {
  id: string
  type: 'fact'
  text: string
  props: Record<string, unknown>
  ownerUserId: string | null
  visibility: 'shared'
}

/**
 * Pure: turn facts into nodes and edges. Deliberately emits NO bare account or
 * opportunity nodes — upsertNodes is a full replace, so a bare node would
 * clobber the richer shared entity node enrichEntities maintains. The edge
 * links to the existing entity and is a no-op when it isn't indexed yet.
 */
export function buildFactGraph(
  organizationId: string,
  facts: IndexableFact[],
): { nodes: PendingFactNode[]; edges: GraphEdge[] } {
  const nodes: PendingFactNode[] = []
  const edges: GraphEdge[] = []

  for (const fact of facts) {
    const id = factNodeId(fact.provider, fact.externalId)
    nodes.push({
      id,
      type: 'fact',
      text: fact.text.slice(0, 1500),
      props: { provider: fact.provider, kind: fact.kind, externalId: fact.externalId, ...fact.props },
      // Workspace data, not one rep's private note.
      ownerUserId: null,
      visibility: 'shared',
    })
    if (fact.accountId) {
      edges.push({ organizationId, from: id, to: nodeIds.account(fact.accountId), rel: 'about_account' })
    }
    if (fact.opportunityId) {
      edges.push({ organizationId, from: id, to: nodeIds.opportunity(fact.opportunityId), rel: 'about_opportunity' })
    }
    if (fact.runId) {
      edges.push({ organizationId, from: id, to: nodeIds.run(fact.runId), rel: 'captured_in' })
    }
  }

  return { nodes, edges }
}

/** Best-effort indexing; gated on embeddings inside commitGraph, never throws. */
export async function indexCapturedFacts(organizationId: string, facts: IndexableFact[]): Promise<void> {
  if (facts.length === 0) return
  try {
    const { nodes, edges } = buildFactGraph(organizationId, facts)
    await commitGraph(organizationId, nodes, edges)
  } catch (error) {
    apiLogger.warn('indexCapturedFacts failed', {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
```

- [ ] **Step 6: Call it from the capture service**

In `src/lib/capture/capture.ts`, replace the whole `for (const fact of facts) { ... }` loop written in Task 4 with this version, which keeps each upserted row and indexes once at the end:

```ts
    const indexable: IndexableFact[] = []
    for (const fact of facts) {
      const target = await resolveFactTarget(
        fact,
        { signalAccountId: input.signalAccountId, signalOpportunityId: input.signalOpportunityId },
        lookup,
      )
      const row = await prisma.capturedFact.upsert({
        where: {
          organizationId_provider_externalId: {
            organizationId: input.organizationId,
            provider,
            externalId: fact.externalId,
          },
        },
        create: {
          organizationId: input.organizationId,
          provider,
          tool: input.tool,
          kind: fact.kind,
          externalId: fact.externalId,
          text: fact.text,
          props: fact.props as never,
          accountId: target.accountId,
          opportunityId: target.opportunityId,
          runId: input.runId ?? null,
          expiresAt,
        },
        update: {
          text: fact.text,
          props: fact.props as never,
          // Only ever ADD linkage: a later observation without run context must
          // not unlink a fact an earlier one resolved.
          ...(target.accountId ? { accountId: target.accountId } : {}),
          ...(target.opportunityId ? { opportunityId: target.opportunityId } : {}),
          runId: input.runId ?? null,
          capturedAt: new Date(),
          expiresAt,
        },
      })
      indexable.push({
        id: row.id,
        text: row.text,
        provider: row.provider,
        kind: row.kind,
        externalId: row.externalId,
        props: (row.props ?? {}) as Record<string, unknown>,
        accountId: row.accountId,
        opportunityId: row.opportunityId,
        runId: row.runId,
      })
    }
    // Postgres first, graph second: graph-RAG no-ops without embeddings
    // configured, so a graph-only write would silently capture nothing.
    await indexCapturedFacts(input.organizationId, indexable)
```

Add the import:

```ts
import { indexCapturedFacts, type IndexableFact } from './index-facts'
```

- [ ] **Step 7: Run the tests**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/capture/__tests__/index-facts.test.ts`
Expected: PASS, 5 tests.

Run: `TEST_DATABASE_URL=<your-db-url> npm test` — the capture DB tests must still pass with indexing wired in.
Then: `npm run typecheck && npm run lint`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/rag/store.ts src/lib/capture
git commit -m "feat(capture): put captured facts on the graph beside accounts"
```

---

### Task 7: Retention

**Files:**
- Modify: `src/app/api/cron/retention/route.ts`
- Test: `src/app/api/cron/__tests__/capture-retention.db.test.ts`

**Interfaces:**
- Consumes: `CapturedFact.expiresAt` (Task 1).
- Produces: a `capturedFactsDeleted` count in the retention response.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/cron/__tests__/capture-retention.db.test.ts`:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let orgId: string

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const org = await prisma.organization.create({
      data: { name: 'ret', slug: `ret-${crypto.randomUUID()}` },
    })
    orgId = org.id
    const mk = (externalId: string, expiresAt: Date) =>
      prisma.capturedFact.create({
        data: {
          organizationId: orgId, provider: 'jira', tool: 'jira_list_issues',
          kind: 'issue', externalId, text: 't', expiresAt,
        },
      })
    await mk('EXPIRED-1', new Date(Date.now() - 86_400_000))
    await mk('LIVE-1', new Date(Date.now() + 86_400_000))
  })

  after(async () => {
    if (orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => {})
  })

  test('the sweep deletes only facts past their expiry', async () => {
    const { sweepExpiredFacts } = await import('../retention/route')
    const deleted = await sweepExpiredFacts()
    assert.ok(deleted >= 1)
    const remaining = await prisma.capturedFact.findMany({ where: { organizationId: orgId } })
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0].externalId, 'LIVE-1')
  })
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL=<your-db-url> TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/cron/__tests__/capture-retention.db.test.ts`
Expected: FAIL — `sweepExpiredFacts is not a function`.

- [ ] **Step 3: Add the sweep**

In `src/app/api/cron/retention/route.ts`, add above the handler. Note the existing file batches its deletes so a backlog drains over successive runs rather than in one long transaction — follow that shape:

```ts
/** Bound per run, matching the other sweeps: a backlog drains over days. */
const CAPTURED_FACT_BATCH = 5_000

/**
 * Delete captured facts past their expiry. Exported for the test — a route
 * module may only export HTTP handlers and route config as VALUES, and this is
 * a function export, which is fine; keep it a function, not a const object.
 */
export async function sweepExpiredFacts(): Promise<number> {
  // systemPrisma: a cron sweep is org-less by nature.
  const stale = await systemPrisma.capturedFact.findMany({
    where: { expiresAt: { lt: new Date() } },
    select: { id: true },
    take: CAPTURED_FACT_BATCH,
  })
  if (stale.length === 0) return 0
  const { count } = await systemPrisma.capturedFact.deleteMany({
    where: { id: { in: stale.map((row) => row.id) } },
  })
  return count
}
```

Call it inside the handler alongside the existing sweeps and add its count to the logged summary and the JSON response:

```ts
    const capturedFactsDeleted = await sweepExpiredFacts()
```

```ts
    apiLogger.info('cron/retention complete', { days, executionsDeleted, signalsDeleted, transcriptsPruned, capturedFactsDeleted })
    return Response.json({ success: true, days, executionsDeleted, signalsDeleted, transcriptsPruned, capturedFactsDeleted })
```

- [ ] **Step 4: Run the tests**

Run: `TEST_DATABASE_URL=<your-db-url> TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/cron/__tests__/capture-retention.db.test.ts`
Expected: PASS, 1 test.

Then `TEST_DATABASE_URL=<your-db-url> npm test` and `npm run typecheck && npm run lint`.

**If `next build` later fails with "sweepExpiredFacts is not a valid Route export field"**, move the function to `src/lib/capture/retention.ts` and import it into the route — Next 15 restricts route module exports. Test the lib module directly in that case.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/cron/retention/route.ts src/app/api/cron/__tests__/capture-retention.db.test.ts
git commit -m "feat(capture): expire captured facts on the retention sweep"
```

---

### Task 8: The outbound sink

**Files:**
- Create: `src/lib/capture/sinks.ts`
- Modify: `src/lib/capture/capture.ts` (emit through the sink list)
- Test: `src/lib/capture/__tests__/sinks.test.ts`

**Interfaces:**
- Consumes: `IndexableFact`, `indexCapturedFacts` (Task 6).
- Produces:
  - `interface FactSink { readonly name: string; emit(organizationId: string, facts: IndexableFact[]): Promise<void> }`
  - `activeSinks(): FactSink[]`
  - `peopleAiSinkConfigured(): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/lib/capture/__tests__/sinks.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PeopleAiSink, peopleAiSinkConfigured, emitToSinks } from '../sinks'
import type { FactSink } from '../sinks'

const fact = {
  id: 'cf1', text: 'ACME-14', provider: 'jira', kind: 'issue', externalId: 'ACME-14',
  props: {}, accountId: 'acct-1', opportunityId: null, runId: null,
}

test('the People.ai sink is inert until its endpoint is configured', async () => {
  delete process.env.PEOPLE_AI_FACTS_PATH
  assert.equal(peopleAiSinkConfigured(), false)

  let called = false
  const sink = new PeopleAiSink({ fetchImpl: async () => { called = true; return new Response('{}') } })
  await sink.emit('org-1', [fact])
  assert.equal(called, false, 'an unconfigured sink must make no request')
})

test('once configured, the sink PUTs to the configured path with service auth', async () => {
  process.env.PEOPLE_AI_FACTS_PATH = '/v1/salesai/facts'
  process.env.PEOPLE_AI_SERVICE_CLIENT_ID = 'id'
  process.env.PEOPLE_AI_SERVICE_CLIENT_SECRET = 'secret'
  try {
    assert.equal(peopleAiSinkConfigured(), true)
    let seen: { url: string; init: RequestInit } | null = null
    const sink = new PeopleAiSink({
      fetchImpl: async (url: string, init: RequestInit) => {
        seen = { url, init }
        return new Response('{}', { status: 200 })
      },
    })
    await sink.emit('org-1', [fact])
    assert.match(seen!.url, /\/v1\/salesai\/facts$/)
    assert.equal(seen!.init.method, 'PUT')
    assert.equal((seen!.init.headers as Record<string, string>)['PAI-Client-Id'], 'id')
  } finally {
    delete process.env.PEOPLE_AI_FACTS_PATH
    delete process.env.PEOPLE_AI_SERVICE_CLIENT_ID
    delete process.env.PEOPLE_AI_SERVICE_CLIENT_SECRET
  }
})

test('one failing sink never stops the others', async () => {
  const emitted: string[] = []
  const sinks: FactSink[] = [
    { name: 'boom', async emit() { throw new Error('sink down') } },
    { name: 'ok', async emit() { emitted.push('ok') } },
  ]
  await assert.doesNotReject(() => emitToSinks(sinks, 'org-1', [fact]))
  assert.deepEqual(emitted, ['ok'])
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/capture/__tests__/sinks.test.ts`
Expected: FAIL — `Cannot find module '../sinks'`.

- [ ] **Step 3: Write the sinks**

Create `src/lib/capture/sinks.ts`:

```ts
/**
 * Where captured facts go.
 *
 * GraphRagSink ships today. PeopleAiSink is the seam for pushing enrichment
 * back into Sales AI — the RESOURCE PATH IS NOT YET KNOWN (see the spec's open
 * questions: every People.ai tool this codebase knows is a read, and the only
 * REST endpoint on record is POST /v1/salesai/webhooks). It therefore stays
 * inert until PEOPLE_AI_FACTS_PATH is set, at which point it needs no code
 * change. This mirrors register-webhook.ts, which documents itself the same way.
 */
import { apiLogger } from '@/lib/logger'
import { indexCapturedFacts, type IndexableFact } from './index-facts'

export interface FactSink {
  readonly name: string
  emit(organizationId: string, facts: IndexableFact[]): Promise<void>
}

export const graphRagSink: FactSink = {
  name: 'graph-rag',
  emit: (organizationId, facts) => indexCapturedFacts(organizationId, facts),
}

const SALESAI_BASE_URL = () => process.env.PEOPLE_AI_SALESAI_BASE_URL || 'https://api.people.ai'

/** True once an ingest path and service credentials are configured. */
export function peopleAiSinkConfigured(): boolean {
  return Boolean(
    process.env.PEOPLE_AI_FACTS_PATH &&
    process.env.PEOPLE_AI_SERVICE_CLIENT_ID &&
    process.env.PEOPLE_AI_SERVICE_CLIENT_SECRET,
  )
}

export class PeopleAiSink implements FactSink {
  readonly name = 'people-ai'
  private readonly fetchImpl: typeof fetch

  constructor(options: { fetchImpl?: typeof fetch } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async emit(organizationId: string, facts: IndexableFact[]): Promise<void> {
    // Inert by default: no endpoint, no request. This is the documented state
    // until the SalesAI ingest contract is known.
    if (!peopleAiSinkConfigured()) return

    const response = await this.fetchImpl(`${SALESAI_BASE_URL()}${process.env.PEOPLE_AI_FACTS_PATH}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'PAI-Client-Id': process.env.PEOPLE_AI_SERVICE_CLIENT_ID!,
        'PAI-Client-Secret': process.env.PEOPLE_AI_SERVICE_CLIENT_SECRET!,
      },
      body: JSON.stringify({
        organization_id: organizationId,
        facts: facts.map((fact) => ({
          source: fact.provider,
          kind: fact.kind,
          external_id: fact.externalId,
          summary: fact.text,
          attributes: fact.props,
          account_id: fact.accountId,
          opportunity_id: fact.opportunityId,
        })),
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`People.ai facts ingest returned ${response.status}`)
  }
}

/** Every sink that should receive facts in this environment. */
export function activeSinks(): FactSink[] {
  return peopleAiSinkConfigured() ? [graphRagSink, new PeopleAiSink()] : [graphRagSink]
}

/** Emit to every sink; one failing sink never stops the others. */
export async function emitToSinks(
  sinks: FactSink[],
  organizationId: string,
  facts: IndexableFact[],
): Promise<void> {
  for (const sink of sinks) {
    try {
      await sink.emit(organizationId, facts)
    } catch (error) {
      apiLogger.warn('fact sink failed', {
        sink: sink.name,
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
```

- [ ] **Step 4: Route capture through the sinks**

In `src/lib/capture/capture.ts`, replace the direct `indexCapturedFacts` call from Task 6 with:

```ts
    await emitToSinks(activeSinks(), input.organizationId, indexable)
```

and swap the import:

```ts
import { activeSinks, emitToSinks } from './sinks'
import type { IndexableFact } from './index-facts'
```

- [ ] **Step 5: Run the tests**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/capture/__tests__/sinks.test.ts`
Expected: PASS, 3 tests.

Run: `TEST_DATABASE_URL=<your-db-url> npm test` and `npm run typecheck && npm run lint`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/capture
git commit -m "feat(capture): send facts through sinks, with People.ai inert until wired"
```

---

## Verification

After Task 8, confirm:

1. `TEST_DATABASE_URL=<db> npm test` — full suite green.
2. `npm run typecheck && npm run lint` — clean.
3. Migration applies from zero and `prisma migrate diff --from-url <db> --to-schema-datamodel prisma/schema.prisma --exit-code` reports no drift.
4. `next build` compiles with placeholder Supabase env.
5. A workspace with capture off runs a Jira-reading flow and writes zero `captured_facts` rows.
6. The same workspace with capture on for Jira writes one row per issue, deduped by key on a second run, linked to the account when the run was signal-triggered.
7. `PeopleAiSink` makes no outbound request with `PEOPLE_AI_FACTS_PATH` unset.

## Follow-on

The People.ai ingest path remains unknown (spec §8). When the contract is
available, wiring it is: set `PEOPLE_AI_FACTS_PATH`, confirm the request body
against the guide, and adjust `PeopleAiSink.emit`'s body mapping. No other
module changes.
