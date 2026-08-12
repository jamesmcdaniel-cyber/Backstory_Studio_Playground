# Revocation Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make suspending a user actually revoke their credentials — locally, upstream at the provider, and for any work they owned — so a deactivated account cannot execute anything.

**Architecture:** Three layers. A Prisma client extension makes an inactive owner's credential rows unresolvable no matter which call site asks (prevents use). `revokeUserAccess()` deletes the rows, revokes API keys, and quarantines owned work (removes possession). An outbox-retried `credential.revoke` job deletes the grant at Nango (removes the grant). Two independent bugs — cross-user credential borrowing and scheduler re-attribution — are fixed alongside.

**Tech Stack:** TypeScript, Next.js App Router, Prisma (client extensions), PostgreSQL, `node:test` + `node:assert/strict`, tsx.

**Spec:** `docs/superpowers/specs/2026-08-12-revocation-spine-design.md`

## Global Constraints

- Run tests with `npm test`. A single file: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/path/to/file.test.ts`.
- Gates before every commit: `npm run typecheck` and `npm run lint`. Do NOT run `npm run build` — this machine has no Supabase env vars and the build 500s by design; Vercel validates builds.
- Tests live in a `__tests__/` directory beside the code. Pure tests are `*.test.ts`; tests requiring a database are `*.db.test.ts` and MUST gate on `process.env.TEST_DATABASE_URL`, following `src/lib/nango/__tests__/connection-resolution.db.test.ts`.
- Keep test files under ~45KB. Files crossing that hang tsx+node22 at load.
- Migrations are applied with `prisma migrate deploy` against a baselined database. Write the SQL by hand in `prisma/migrations/<timestamp>_<name>/migration.sql`. Do NOT run `prisma migrate dev` (it will try to reset).
- Use `prisma` (the guarded client) in user-facing code. `systemPrisma` is for enumerated system paths only and requires a one-line justification comment at the call site.
- The four user-owned credential models are exactly: `Integration`, `PeopleAiConnection`, `McpConnection`, `NangoConnection`. `HttpCredential` and `IntegrationSecret` have no `userId` and are deliberately excluded.
- Commit after each task. Do not push.

---

### Task 1: `quarantinedAt` column and scheduler exclusion

Adds the marker that quarantine hangs off, and makes the scheduler honour it. `quarantinedAt` is the single source of truth — no status column is mutated anywhere in this plan.

**Files:**
- Modify: `prisma/schema.prisma` (Flow model ~line 889, AgentTask model ~line 309)
- Create: `prisma/migrations/20260812120000_work_quarantine/migration.sql`
- Modify: `src/lib/scheduling/dispatch-tick.ts:245` and `:428`
- Test: `src/lib/scheduling/__tests__/quarantine-dispatch.db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Flow.quarantinedAt: DateTime?` and `AgentTask.quarantinedAt: DateTime?`. Task 6 writes them; Task 9 reads them.

- [ ] **Step 1: Add the column to both models**

In `prisma/schema.prisma`, add to `model Flow` (immediately after the `userId` field):

```prisma
  /// Set when the owner was deprovisioned. Quarantined work never dispatches
  /// and appears in the admin claim queue until someone takes ownership.
  /// Deliberately ORTHOGONAL to `status`: overwriting status would destroy the
  /// prior value, so a claimed draft would come back as ACTIVE.
  quarantinedAt  DateTime? @db.Timestamptz(6)
```

Add to `model AgentTask` (immediately after its `userId` field):

```prisma
  /// See Flow.quarantinedAt — set when the owner was deprovisioned.
  quarantinedAt  DateTime? @db.Timestamptz(6)
```

- [ ] **Step 2: Write the migration**

Create `prisma/migrations/20260812120000_work_quarantine/migration.sql`:

```sql
ALTER TABLE "flows" ADD COLUMN "quarantinedAt" TIMESTAMPTZ(6);
ALTER TABLE "agent_tasks" ADD COLUMN "quarantinedAt" TIMESTAMPTZ(6);

-- Dispatch filters on this every tick; both are partial indexes because the
-- overwhelming majority of rows are NULL and never need to be visited.
CREATE INDEX "flows_quarantined_idx" ON "flows" ("quarantinedAt") WHERE "quarantinedAt" IS NOT NULL;
CREATE INDEX "agent_tasks_quarantined_idx" ON "agent_tasks" ("quarantinedAt") WHERE "quarantinedAt" IS NOT NULL;
```

Verify the table names against `@@map` in `prisma/schema.prisma` before running — `Flow` maps to `flows` and `AgentTask` to `agent_tasks`. If either differs, fix the SQL.

- [ ] **Step 3: Generate the client and confirm it compiles**

Run: `npm run typecheck`
Expected: PASS. (`prisma generate` runs as part of it.)

- [ ] **Step 4: Write the failing test**

Create `src/lib/scheduling/__tests__/quarantine-dispatch.db.test.ts`:

```ts
import { test, before } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Quarantined work must not dispatch. Both candidate queries in dispatch-tick
 * use systemPrisma, which bypasses the credential owner guard — so the filter
 * has to be written out explicitly there, and this pins that it is.
 */

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seedTestOrg: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg } = await import('@/lib/server/__tests__/test-auth'))
  })

  test('a quarantined ACTIVE flow is not a dispatch candidate', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const flow = await prisma.flow.create({
        data: {
          organizationId: s.organizationId,
          userId: s.userId,
          name: 'quarantined',
          status: 'ACTIVE',
          publishedGraph: { nodes: [], edges: [] },
          trigger: { type: 'schedule', schedule: { kind: 'hourly' } },
          quarantinedAt: new Date(),
        },
      })

      const candidates = await prisma.flow.findMany({
        where: { organizationId: s.organizationId, status: 'ACTIVE', quarantinedAt: null },
        select: { id: true },
      })

      assert.equal(
        candidates.some((row: { id: string }) => row.id === flow.id),
        false,
        'quarantined flow must be excluded from dispatch candidates',
      )
    } finally {
      await s.cleanup()
    }
  })

  test('a quarantined ACTIVE agent task is not a dispatch candidate', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const task = await prisma.agentTask.create({
        data: {
          organizationId: s.organizationId,
          userId: s.userId,
          description: 'quarantined',
          objective: 'none',
          status: 'ACTIVE',
          quarantinedAt: new Date(),
        },
      })

      const candidates = await prisma.agentTask.findMany({
        where: { organizationId: s.organizationId, status: 'ACTIVE', quarantinedAt: null },
        select: { id: true },
      })

      assert.equal(
        candidates.some((row: { id: string }) => row.id === task.id),
        false,
        'quarantined agent task must be excluded from dispatch candidates',
      )
    } finally {
      await s.cleanup()
    }
  })
}
```

- [ ] **Step 5: Run the test**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/scheduling/__tests__/quarantine-dispatch.db.test.ts`
Expected: PASS if `TEST_DATABASE_URL` is set, or silently skip if not. If it fails on an unknown `quarantinedAt` column, the migration has not been applied — run `npm run db:deploy` against the test database first.

- [ ] **Step 6: Add the filter to both dispatch queries**

In `src/lib/scheduling/dispatch-tick.ts` around line 245, change:

```ts
      systemPrisma.agentTask.findMany({
        where: { status: 'ACTIVE' },
```

to:

```ts
      systemPrisma.agentTask.findMany({
        // quarantinedAt: work whose owner was deprovisioned. systemPrisma
        // bypasses the credential owner guard, so the exclusion is explicit here.
        where: { status: 'ACTIVE', quarantinedAt: null },
```

Around line 428, change:

```ts
        where: { status: 'ACTIVE', publishedGraph: { not: Prisma.AnyNull } },
```

to:

```ts
        where: { status: 'ACTIVE', publishedGraph: { not: Prisma.AnyNull }, quarantinedAt: null },
```

- [ ] **Step 7: Verify gates**

Run: `npm run typecheck && npm run lint`
Expected: both PASS.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260812120000_work_quarantine src/lib/scheduling/dispatch-tick.ts src/lib/scheduling/__tests__/quarantine-dispatch.db.test.ts
git commit -m "feat(revocation): add quarantinedAt and exclude quarantined work from dispatch"
```

---

### Task 2: Scheduler stops re-attributing a deactivated owner's work

Today an inactive named owner silently falls back to the org's oldest active member. That fallback is correct for genuinely shared rows (`userId === null`) and wrong when a named owner was deprovisioned.

`attributeOwners` is pure and currently cannot tell "owner deactivated" from "owner row absent" — both arrive as missing from `explicitOwners`. The fix is to give it the information: stop filtering `isActive` in the explicit-owner query and pass the flag through.

**Files:**
- Modify: `src/lib/scheduling/owners.ts`
- Modify: `src/lib/scheduling/__tests__/owners.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ActiveMember` gains a required `isActive: boolean`. `attributeOwners(candidates, explicitOwners, members)` keeps its signature; `explicitOwners` now includes inactive users.

- [ ] **Step 1: Write the failing test**

In `src/lib/scheduling/__tests__/owners.test.ts`, first FIX the existing test named `'a named owner who is deactivated falls back too'`. It passes `explicitOwners: []`, which under the new semantics means "user row not found", not "deactivated" — it is mislabelled and would keep passing while testing nothing relevant. Rename it and make its intent explicit:

```ts
test('a named owner whose user row is absent entirely falls back', () => {
  // Not the deactivation case — this is a dangling userId with no row at all.
  const owners = attributeOwners(
    [{ id: 'agent-1', organizationId: ORG_A, userId: 'user-gone' }],
    [],
    [{ id: 'user-a-oldest', organizationId: ORG_A, isActive: true }],
  )

  assert.equal(owners.get('agent-1'), 'user-a-oldest')
})
```

Then add the genuine deactivation test:

```ts
test('a named owner who was DEACTIVATED quarantines the row — it does not re-attribute', () => {
  // The core of the revocation spine: a suspended person's scheduled work must
  // stop, not silently continue under a colleague's identity.
  const owners = attributeOwners(
    [{ id: 'agent-1', organizationId: ORG_A, userId: 'user-suspended' }],
    [{ id: 'user-suspended', organizationId: ORG_A, isActive: false }],
    [{ id: 'user-a-oldest', organizationId: ORG_A, isActive: true }],
  )

  assert.equal(owners.has('agent-1'), false, 'callers skip absent candidates, so the work does not dispatch')
})
```

Every other `attributeOwners` call in this file needs `isActive: true` added to each member object, since the field is now required.

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/scheduling/__tests__/owners.test.ts`
Expected: FAIL — the deactivation test gets `'user-a-oldest'` instead of an absent key, and TypeScript flags the extra `isActive` property.

- [ ] **Step 3: Implement**

In `src/lib/scheduling/owners.ts`, add `isActive` to the interface:

```ts
/** A user row as both lookups below select it. */
export interface ActiveMember {
  id: string
  organizationId: string | null
  isActive: boolean
}
```

In `attributeOwners`, replace the owner-resolution block:

```ts
  for (const candidate of candidates) {
    // The named owner counts only if they are still in THIS org. Without that
    // check, someone who moved workspaces would keep being credited with — and
    // have their identity used for — runs in the org they left.
    const explicit = candidate.userId ? explicitById.get(candidate.userId) : undefined

    // A named owner who was DEPROVISIONED stops the work entirely. Falling back
    // here would hand a suspended person's automation to an unrelated colleague
    // and keep running it under their identity — the exact failure the
    // revocation spine exists to close. Absent from the map = callers skip it.
    if (explicit && !explicit.isActive) continue

    const owner =
      explicit?.organizationId === candidate.organizationId
        ? candidate.userId!
        : fallbackByOrg.get(candidate.organizationId)
    if (owner) owners.set(candidate.id, owner)
  }
```

and change `explicitById` to carry the whole row:

```ts
  const explicitById = new Map(explicitOwners.map((user) => [user.id, user]))
```

The `fallbackByOrg` loop must only consider active members:

```ts
  const fallbackByOrg = new Map<string, string>()
  for (const member of members) {
    if (member.isActive && member.organizationId && !fallbackByOrg.has(member.organizationId)) {
      fallbackByOrg.set(member.organizationId, member.id)
    }
  }
```

In `resolveRunOwners`, drop the `isActive: true` filter from the explicit-owner query and select the column — this is what makes the distinction visible at all. The fallback-members query keeps its filter:

```ts
  const [explicitOwners, members] = await Promise.all([
    explicitIds.length
      ? systemPrisma.user.findMany({
          // NOT filtered on isActive: attributeOwners must be able to tell a
          // DEACTIVATED owner (quarantine the row) from an ABSENT one (fall back).
          where: { id: { in: explicitIds } },
          select: { id: true, organizationId: true, isActive: true },
        })
      : Promise.resolve([] as ActiveMember[]),
    systemPrisma.user.findMany({
      where: { organizationId: { in: orgIds }, isActive: true },
      select: { id: true, organizationId: true, isActive: true },
      orderBy: { createdAt: 'asc' },
    }),
  ])
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/scheduling/__tests__/owners.test.ts`
Expected: PASS, all tests including the pre-existing ones.

- [ ] **Step 5: Verify gates and commit**

```bash
npm run typecheck && npm run lint
git add src/lib/scheduling/owners.ts src/lib/scheduling/__tests__/owners.test.ts
git commit -m "fix(scheduling): a deprovisioned owner's work stops instead of re-attributing"
```

---

### Task 3: No member executes through another member's personal credential

`resolveNangoConnection` ends its fallback chain with `candidates[0]` — an arbitrary other member's personal connection. This violates the agents-act-as-user mandate and is independent of deactivation.

**Files:**
- Modify: `src/lib/nango/delivery.ts:132-138`
- Test: `src/lib/nango/__tests__/connection-resolution.db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveNangoConnection` returns `null` where it previously borrowed a colleague's connection. Callers already handle `null`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/nango/__tests__/connection-resolution.db.test.ts`, inside the existing `if (TEST_DB) {` block:

```ts
  test('one member never executes through another member’s personal connection', async () => {
    // agents-act-as-user: borrowing a colleague's OAuth token makes the action
    // unattributable and posts as someone who never consented to this run.
    const s = await seedTestOrg(prisma)
    try {
      const colleague = await prisma.user.create({
        data: { supabaseId: crypto.randomUUID(), email: 'colleague@example.com', organizationId: s.organizationId },
      })
      await connect(s.organizationId, 'slack', colleague.id)

      const resolved = await resolveNangoConnection(s.organizationId, ['slack'], s.userId)

      assert.equal(resolved, null, 'must resolve nothing rather than borrow a colleague’s token')
    } finally {
      await s.cleanup()
    }
  })

  test('an org-shared connection is still resolvable by any member', async () => {
    // The legitimate case the fallback removal must NOT break: userId === null
    // means the workspace owns it.
    const s = await seedTestOrg(prisma)
    try {
      await connect(s.organizationId, 'slack', null)

      const resolved = await resolveNangoConnection(s.organizationId, ['slack'], s.userId)

      assert.ok(resolved, 'org-shared connections remain available to everyone')
      assert.equal(resolved.scope, 'org')
    } finally {
      await s.cleanup()
    }
  })
```

Add `import crypto from 'node:crypto'` at the top of the file if it is not already imported, and add `resolveNangoConnection` to the existing destructured import in the `before` block if absent.

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/nango/__tests__/connection-resolution.db.test.ts`
Expected: FAIL on the first new test — it resolves the colleague's connection instead of `null`.

- [ ] **Step 3: Implement**

In `src/lib/nango/delivery.ts`, replace lines 132-138:

```ts
  const own = userId ? candidates.find((connection) => connection.userId === userId) : undefined
  const chosen = own ?? candidates.find((connection) => !connection.userId)

  // No `?? candidates[0]`. That fallback picked an ARBITRARY OTHER MEMBER's
  // personal connection, so one person's flow executed through a colleague's
  // OAuth token — unattributable, and posting as someone who never consented to
  // this run. Resolving nothing surfaces "connect your account" instead.
  if (!chosen) return null

  return {
    connectionId: chosen.connectionId,
    providerConfigKey: chosen.providerConfigKey,
    scope: chosen.userId === userId && userId ? 'user' : 'org',
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/nango/__tests__/connection-resolution.db.test.ts`
Expected: PASS, including the pre-existing variant-provider-key tests.

- [ ] **Step 5: Verify gates and commit**

```bash
npm run typecheck && npm run lint
git add src/lib/nango/delivery.ts src/lib/nango/__tests__/connection-resolution.db.test.ts
git commit -m "fix(nango): stop resolving another member's personal connection"
```

---

### Task 4: The owner-liveness predicate (pure)

The decision with no database in it, so it is unit-testable and has one home. Wiring comes in Task 5.

**Files:**
- Create: `src/lib/authz/credential-owner-guard.ts`
- Test: `src/lib/authz/__tests__/credential-owner-guard.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `OWNER_LIVENESS_MODELS: ReadonlySet<string>`
  - `applyOwnerLiveness(model: string | undefined, operation: string, args: unknown): unknown`
  - `UnfilterableCredentialReadError extends Error`

- [ ] **Step 1: Write the failing test**

Create `src/lib/authz/__tests__/credential-owner-guard.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyOwnerLiveness, OWNER_LIVENESS_MODELS, UnfilterableCredentialReadError } from '../credential-owner-guard'

const LIVENESS = { OR: [{ userId: null }, { user: { is: { isActive: true } } }] }

test('a credential read gains the owner-liveness filter', () => {
  const args = applyOwnerLiveness('McpConnection', 'findMany', { where: { organizationId: 'org-1' } })

  assert.deepEqual(args, { where: { AND: [{ organizationId: 'org-1' }, LIVENESS] } })
})

test('a read with no where clause still gets filtered', () => {
  // Otherwise the least-scoped query in the codebase is the one that leaks.
  const args = applyOwnerLiveness('Integration', 'findMany', {})

  assert.deepEqual(args, { where: LIVENESS })
})

test('models outside the registry are untouched', () => {
  // HttpCredential and IntegrationSecret are workspace-owned and have no userId.
  // Filtering them would break the org when any one person leaves.
  const original = { where: { organizationId: 'org-1' } }

  assert.equal(applyOwnerLiveness('HttpCredential', 'findMany', original), original)
  assert.equal(applyOwnerLiveness('Flow', 'findMany', original), original)
})

test('writes are untouched — this layer prevents USE, not removal', () => {
  // revokeUserAccess must be able to delete these rows, and the sweeper updates
  // them. Layer 2 handles removal; filtering writes here would fight it.
  const original = { where: { id: 'row-1' }, data: { isActive: false } }

  assert.equal(applyOwnerLiveness('McpConnection', 'update', original), original)
  assert.equal(applyOwnerLiveness('McpConnection', 'deleteMany', original), original)
})

test('findUnique on a registry model throws rather than silently skipping the filter', () => {
  // findUnique accepts only unique fields in `where`, so the filter cannot be
  // injected. Failing loudly is the whole point: a silent pass-through would
  // leave a hole exactly where the People.ai OAuth tokens are read.
  assert.throws(
    () => applyOwnerLiveness('PeopleAiConnection', 'findUnique', { where: { id: 'x' } }),
    UnfilterableCredentialReadError,
  )
})

test('the registry is exactly the four user-owned credential models', () => {
  assert.deepEqual(
    [...OWNER_LIVENESS_MODELS].sort(),
    ['Integration', 'McpConnection', 'NangoConnection', 'PeopleAiConnection'],
  )
})

test('no model gains a user-owned credential shape without joining the registry', () => {
  // The regression net. A new per-user credential model added in six months
  // would otherwise be silently exempt from the invariant — which is exactly how
  // deactivation ended up exempt from the revocation logic in the first place.
  const CREDENTIAL_FIELD = /^(accessToken|refreshToken|authConfig|apiKey|secret|credentials)$/i

  const candidates = Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((f) => f.name === 'userId'))
    .filter((model) => model.fields.some((f) => CREDENTIAL_FIELD.test(f.name)))
    .map((model) => model.name)

  const unregistered = candidates.filter((name) => !OWNER_LIVENESS_MODELS.has(name))

  assert.deepEqual(
    unregistered,
    [],
    `these models carry a userId and a credential but are not in OWNER_LIVENESS_MODELS: ${unregistered.join(', ')}. ` +
      `Add them to the registry, or document why the credential survives its owner.`,
  )
})
```

Add `import { Prisma } from '@prisma/client'` at the top of the test file.

`Integration` and `NangoConnection` have no matching credential column — Nango and the provider hold the secret, and the row is a pointer. They are registered explicitly rather than discovered, so the assertion above is one-directional: it catches new models joining, and the literal-list test above it catches registered models being dropped.

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/authz/__tests__/credential-owner-guard.test.ts`
Expected: FAIL — cannot resolve `../credential-owner-guard`.

- [ ] **Step 3: Implement**

Create `src/lib/authz/credential-owner-guard.ts`:

```ts
/**
 * Owner-liveness guard for user-owned credentials.
 *
 * Deprovisioning used to be identity-only: `isActive: false` plus a banned
 * Supabase session, with every credential row left intact and usable. The
 * revocation itself (src/lib/revoke-user-access.ts) removes those rows — but
 * correctness cannot depend on every current AND future deprovision path
 * remembering to call it. That is precisely how the original bug happened:
 * org-transfer.ts had the revocation logic and deactivation simply never
 * called it.
 *
 * So this is the invariant underneath: a credential whose owner is not an
 * active user is not RESOLVABLE, no matter which call site asks. A missed
 * deprovision path degrades to "unusable but not yet revoked upstream" instead
 * of a live hole.
 *
 * RELATIONSHIP TO THE TENANT GUARD (src/lib/tenant-guard.ts): same registry
 * shape, inverted mechanism. `assertOrgScoped` THROWS on an unscoped query.
 * This REWRITES args to inject a filter, because rejection would break every
 * legitimate read. Both are guardrails, not security boundaries; RLS remains
 * the structural fix.
 *
 * `systemPrisma` bypasses this, as it bypasses the tenant guard. That is
 * required: the revocation sweeper and src/lib/mcp/health-sweep.ts must see
 * these rows in order to clean them up.
 */

/**
 * Models carrying BOTH a `userId` and a credential. `userId: null` on these
 * means org-owned (a shared MCP server, a workspace Nango connection) and stays
 * usable — it belongs to the workspace and does not die with a person.
 *
 * DELIBERATELY ABSENT:
 *   - HttpCredential, IntegrationSecret — no userId at all. Workspace-owned;
 *     revoking them when one person leaves would break the org.
 *   - ApiKey — has a userId, but already fails closed at authentication
 *     (src/lib/public-api/auth.ts re-checks isActive). revokeUserAccess marks
 *     its rows revoked so inventories read correctly.
 */
export const OWNER_LIVENESS_MODELS: ReadonlySet<string> = new Set([
  'Integration',
  'PeopleAiConnection',
  'McpConnection',
  'NangoConnection',
])

/**
 * Reads that accept an arbitrary `where` and can therefore carry the filter.
 * Writes are absent on purpose — this layer prevents USE, not removal, and
 * filtering deletes would fight revokeUserAccess.
 */
const FILTERABLE_READS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
])

/** Reads whose `where` accepts only unique fields, so the filter cannot go in. */
const UNFILTERABLE_READS = new Set(['findUnique', 'findUniqueOrThrow'])

/** The filter itself: org-owned rows, or rows whose owner is still active. */
const OWNER_IS_LIVE = { OR: [{ userId: null }, { user: { is: { isActive: true } } }] } as const

export class UnfilterableCredentialReadError extends Error {
  constructor(model: string, operation: string) {
    super(
      `Credential owner guard: ${model}.${operation} cannot carry the owner-liveness filter, ` +
        `because ${operation} accepts only unique fields in its where clause. ` +
        `Rewrite the call as findFirst with the same conditions — or, for a legitimate ` +
        `system path, use systemPrisma from '@/lib/prisma' with a justification comment.`,
    )
    this.name = 'UnfilterableCredentialReadError'
  }
}

/**
 * Inject the owner-liveness filter into a credential read.
 *
 * Returns `args` unchanged for anything outside the registry, and for writes.
 * Throws `UnfilterableCredentialReadError` on findUnique against a registry
 * model — silently passing those through would leave a hole exactly where the
 * People.ai OAuth tokens are read.
 */
export function applyOwnerLiveness(model: string | undefined, operation: string, args: unknown): unknown {
  if (!model || !OWNER_LIVENESS_MODELS.has(model)) return args
  if (UNFILTERABLE_READS.has(operation)) throw new UnfilterableCredentialReadError(model, operation)
  if (!FILTERABLE_READS.has(operation)) return args

  const record = (args ?? {}) as { where?: unknown }
  const where = record.where
  return {
    ...record,
    where: where ? { AND: [where, OWNER_IS_LIVE] } : OWNER_IS_LIVE,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/authz/__tests__/credential-owner-guard.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Verify gates and commit**

```bash
npm run typecheck && npm run lint
git add src/lib/authz/credential-owner-guard.ts src/lib/authz/__tests__/credential-owner-guard.test.ts
git commit -m "feat(authz): owner-liveness predicate for user-owned credentials"
```

---

### Task 5: Wire the guard into the Prisma client

Attaching the predicate turns it into the invariant. The three `findUnique` sites must be rewritten in the SAME task, or the app throws at runtime the moment the guard goes live.

**Files:**
- Modify: `src/lib/prisma.ts:20-46` (`createGuardedClient`)
- Modify: `src/lib/peopleai/client.ts:123`
- Modify: `src/app/api/peopleai/status/route.ts:20`
- Modify: `src/app/api/nango/connections/[integrationId]/verify/route.ts:59`
- Test: `src/lib/authz/__tests__/credential-invisibility.db.test.ts`

**Interfaces:**
- Consumes: `applyOwnerLiveness` from Task 4.
- Produces: reads through `prisma` on the four registry models exclude inactive owners' rows.

- [ ] **Step 1: Write the failing test**

Create `src/lib/authz/__tests__/credential-invisibility.db.test.ts`:

```ts
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

/**
 * The invariant: a deactivated owner's credentials are unresolvable through the
 * guarded client, and still visible through systemPrisma so the sweeper can
 * clean them up.
 */

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let systemPrisma: any
  let seedTestOrg: any

  before(async () => {
    ;({ prisma, systemPrisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg } = await import('@/lib/server/__tests__/test-auth'))
  })

  /** A second member in the same org, deactivated, holding one of each credential. */
  async function seedSuspendedOwner(organizationId: string) {
    const user = await systemPrisma.user.create({
      data: {
        supabaseId: crypto.randomUUID(),
        email: `suspended-${crypto.randomUUID()}@example.com`,
        organizationId,
        isActive: false,
      },
    })
    await systemPrisma.integration.create({
      data: { organizationId, userId: user.id, provider: 'slack' },
    })
    await systemPrisma.mcpConnection.create({
      data: { organizationId, userId: user.id, name: 'personal', serverUrl: 'https://example.com/mcp' },
    })
    await systemPrisma.nangoConnection.create({
      data: { organizationId, userId: user.id, connectionId: `conn-${user.id}`, providerConfigKey: 'slack', status: 'connected' },
    })
    return user
  }

  test('a suspended owner’s credentials are invisible through the guarded client', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const suspended = await seedSuspendedOwner(s.organizationId)

      const [integrations, mcp, nango] = await Promise.all([
        prisma.integration.findMany({ where: { organizationId: s.organizationId } }),
        prisma.mcpConnection.findMany({ where: { organizationId: s.organizationId } }),
        prisma.nangoConnection.findMany({ where: { organizationId: s.organizationId } }),
      ])

      assert.equal(integrations.some((r: any) => r.userId === suspended.id), false, 'Integration must be filtered')
      assert.equal(mcp.some((r: any) => r.userId === suspended.id), false, 'McpConnection must be filtered')
      assert.equal(nango.some((r: any) => r.userId === suspended.id), false, 'NangoConnection must be filtered')
    } finally {
      await s.cleanup()
    }
  })

  test('the same rows ARE visible through systemPrisma, so the sweeper can clean them', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const suspended = await seedSuspendedOwner(s.organizationId)

      const rows = await systemPrisma.integration.findMany({ where: { organizationId: s.organizationId } })

      assert.equal(rows.some((r: any) => r.userId === suspended.id), true)
    } finally {
      await s.cleanup()
    }
  })

  test('an ACTIVE member’s own credentials stay resolvable', async () => {
    // The guard must not break the ordinary case.
    const s = await seedTestOrg(prisma)
    try {
      await systemPrisma.integration.create({
        data: { organizationId: s.organizationId, userId: s.userId, provider: 'slack' },
      })

      const rows = await prisma.integration.findMany({ where: { organizationId: s.organizationId } })

      assert.equal(rows.some((r: any) => r.userId === s.userId), true)
    } finally {
      await s.cleanup()
    }
  })

  test('org-owned rows (userId null) stay resolvable', async () => {
    const s = await seedTestOrg(prisma)
    try {
      await systemPrisma.mcpConnection.create({
        data: { organizationId: s.organizationId, userId: null, name: 'shared', serverUrl: 'https://example.com/mcp' },
      })

      const rows = await prisma.mcpConnection.findMany({ where: { organizationId: s.organizationId } })

      assert.equal(rows.some((r: any) => r.userId === null), true, 'a workspace-owned server belongs to the org')
    } finally {
      await s.cleanup()
    }
  })
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/authz/__tests__/credential-invisibility.db.test.ts`
Expected: FAIL on the first test — the suspended owner's rows are still returned.

- [ ] **Step 3: Wire the extension**

In `src/lib/prisma.ts`, add the import beside the tenant guard import:

```ts
import { applyOwnerLiveness } from '@/lib/authz/credential-owner-guard'
```

In `createGuardedClient`, inside `$allOperations`, call it AFTER `assertOrgScoped` and use the rewritten args from then on. Order matters: the tenant guard must inspect the caller's ORIGINAL where clause, or the injected `AND` changes what it is judging.

```ts
        async $allOperations({ model, operation, args, query }) {
          assertOrgScoped(model, operation, args)
          // AFTER the tenant guard, so it judges the caller's own where clause
          // rather than one this has already rewritten.
          const guardedArgs = applyOwnerLiveness(model, operation, args) as typeof args
          if (process.env.DATABASE_RLS_ENABLED === 'true' && model && ORG_SCOPED_MODELS.has(model)) {
            const organizationId = exactOrganizationId(guardedArgs)
            if (!organizationId) throw new Error(`RLS context: ${model}.${operation} requires one exact organizationId.`)
            const active = tenantDatabaseContext.getStore()
            if (active) {
              if (active.organizationId !== organizationId) throw new Error('RLS context: cross-workspace query rejected.')
              const delegate = (active.transaction as unknown as Record<string, Record<string, (value: unknown) => unknown>>)[model.charAt(0).toLowerCase() + model.slice(1)]
              return delegate[operation](guardedArgs)
            }
            return appPrismaBase.$transaction(async (tx) => {
              await tx.$queryRaw`SELECT set_config('app.organization_id', ${organizationId}, true)`
              const delegate = (tx as unknown as Record<string, Record<string, (value: unknown) => unknown>>)[model.charAt(0).toLowerCase() + model.slice(1)]
              return delegate[operation](guardedArgs)
            })
          }
          return query(guardedArgs)
        },
```

Note `exactOrganizationId(guardedArgs)` — it must read the rewritten args, since the injected `AND` wraps the original where clause and a lookup against the pre-rewrite shape would disagree with what actually executes. If `exactOrganizationId` cannot see through `AND`, fix it there rather than reordering; reordering reintroduces the tenant-guard problem above.

- [ ] **Step 4: Rewrite the three findUnique sites**

Each compound unique becomes plain field equality, which `findFirst` accepts and the guard can extend.

`src/lib/peopleai/client.ts:123`:

```ts
  const connection = await prisma.peopleAiConnection.findFirst({
    // findFirst, not findUnique: the credential owner guard injects an
    // owner-liveness filter, and findUnique's where clause accepts only unique
    // fields so it cannot carry one. The compound unique is spelled out here.
    where: { organizationId, userId },
  })
```

`src/app/api/peopleai/status/route.ts:20`:

```ts
    prisma.peopleAiConnection.findFirst({
      // findFirst: see getPeopleAiClientForUser — the owner-liveness filter
      // cannot be injected into a findUnique where clause.
      where: { organizationId: auth.organizationId, userId: auth.dbUser.id },
      select: { status: true, teamId: true, membershipId: true, lastVerifiedAt: true },
    }),
```

`src/app/api/nango/connections/[integrationId]/verify/route.ts:59`:

```ts
      const row = await prisma.nangoConnection.findFirst({
        // findFirst: the owner-liveness filter cannot be injected into a
        // findUnique where clause.
        where: {
          organizationId: auth.organizationId,
          connectionId: result.connectionId,
        },
      })
```

The two test-file uses at `src/lib/peopleai/__tests__/connect-service.test.ts:92` and `:131` switch to `systemPrisma`, since they assert on rows directly rather than exercising the app path:

```ts
    // systemPrisma: asserting on the stored row itself, deliberately bypassing
    // the owner-liveness filter that the app path is subject to.
    const connection = await systemPrisma.peopleAiConnection.findUnique({
```

- [ ] **Step 4b: Add the static scan that keeps new findUnique sites out**

Append to `src/lib/authz/__tests__/credential-owner-guard.test.ts`:

```ts
test('no source file reads a registry model through findUnique on the guarded client', () => {
  // The runtime throw only fires if that code path executes. This fails the
  // build instead — the People.ai tokens are the highest-value read in the
  // codebase and a silent hole there is the worst case.
  const models = 'integration|peopleAiConnection|mcpConnection|nangoConnection'
  const pattern = new RegExp(`(?<!system)[Pp]risma\\.(${models})\\.findUnique`)

  const offenders = execSync(
    `find src -type f -name '*.ts' -not -path '*__tests__*'`,
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean)
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))

  assert.deepEqual(
    offenders,
    [],
    `these files read a user-owned credential via findUnique, which cannot carry the ` +
      `owner-liveness filter: ${offenders.join(', ')}. Rewrite them as findFirst.`,
  )
})
```

Add `import { execSync } from 'node:child_process'` and `import { readFileSync } from 'node:fs'` at the top of the test file.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. Any `UnfilterableCredentialReadError` in the output names a `findUnique` site missed in Step 4 — rewrite it the same way.

- [ ] **Step 6: Verify gates and commit**

```bash
npm run typecheck && npm run lint
git add src/lib/prisma.ts src/lib/peopleai/client.ts src/app/api/peopleai/status/route.ts "src/app/api/nango/connections/[integrationId]/verify/route.ts" src/lib/peopleai/__tests__/connect-service.test.ts src/lib/authz/__tests__/credential-invisibility.db.test.ts
git commit -m "feat(authz): make a deprovisioned owner's credentials unresolvable"
```

---

### Task 6: `revokeUserAccess()`

The cleanup that makes revocation real. Modeled on `transferUserToOrganization`, which already does most of this correctly for the transfer case.

**Files:**
- Create: `src/lib/revoke-user-access.ts`
- Test: `src/lib/__tests__/revoke-user-access.db.test.ts`

**Interfaces:**
- Consumes: `GuardedTransactionClient` from `@/lib/prisma`.
- Produces:
  ```ts
  export type RevocationReason = 'member_removed' | 'deactivated' | 'scim_deprovisioned' | 'org_transfer'
  export interface RevocationResult {
    credentials: { integration: number; peopleAiConnection: number; mcpConnection: number; nangoConnection: number; pushSubscription: number }
    apiKeysRevoked: number
    quarantined: { flows: number; agentTasks: number }
    pendingUpstreamRevokes: Array<{ connectionId: string; providerConfigKey: string }>
  }
  export async function revokeUserAccess(tx: GuardedTransactionClient, params: { userId: string; organizationId: string; reason: RevocationReason }): Promise<RevocationResult>
  ```

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/revoke-user-access.db.test.ts`:

```ts
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let systemPrisma: any
  let seedTestOrg: any
  let revokeUserAccess: any

  before(async () => {
    ;({ prisma, systemPrisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg } = await import('@/lib/server/__tests__/test-auth'))
    ;({ revokeUserAccess } = await import('../revoke-user-access'))
  })

  async function seedMemberWithEverything(organizationId: string) {
    const user = await systemPrisma.user.create({
      data: { supabaseId: crypto.randomUUID(), email: `leaver-${crypto.randomUUID()}@example.com`, organizationId },
    })
    await systemPrisma.integration.create({ data: { organizationId, userId: user.id, provider: 'slack' } })
    await systemPrisma.mcpConnection.create({ data: { organizationId, userId: user.id, name: 'personal', serverUrl: 'https://example.com/mcp' } })
    await systemPrisma.nangoConnection.create({ data: { organizationId, userId: user.id, connectionId: `conn-${user.id}`, providerConfigKey: 'slack', status: 'connected' } })
    await systemPrisma.apiKey.create({ data: { organizationId, userId: user.id, name: 'k', keyHash: crypto.randomUUID(), prefix: 'bs_test_1234' } })
    const flow = await systemPrisma.flow.create({ data: { organizationId, userId: user.id, name: 'theirs', status: 'ACTIVE' } })
    return { user, flow }
  }

  test('revocation removes every user-owned credential', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const { user } = await seedMemberWithEverything(s.organizationId)

      const result = await prisma.$transaction((tx: any) =>
        revokeUserAccess(tx, { userId: user.id, organizationId: s.organizationId, reason: 'deactivated' }),
      )

      assert.equal(result.credentials.integration, 1)
      assert.equal(result.credentials.mcpConnection, 1)
      assert.equal(result.credentials.nangoConnection, 1)
      assert.equal(await systemPrisma.integration.count({ where: { userId: user.id } }), 0)
      assert.equal(await systemPrisma.mcpConnection.count({ where: { userId: user.id } }), 0)
    } finally {
      await s.cleanup()
    }
  })

  test('revocation marks their API keys revoked', async () => {
    // They already fail closed at auth, but an un-revoked row makes any
    // credential inventory read wrong.
    const s = await seedTestOrg(prisma)
    try {
      const { user } = await seedMemberWithEverything(s.organizationId)

      await prisma.$transaction((tx: any) =>
        revokeUserAccess(tx, { userId: user.id, organizationId: s.organizationId, reason: 'deactivated' }),
      )

      const live = await systemPrisma.apiKey.count({ where: { userId: user.id, revokedAt: null } })
      assert.equal(live, 0)
    } finally {
      await s.cleanup()
    }
  })

  test('revocation quarantines their work instead of deleting it', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const { user, flow } = await seedMemberWithEverything(s.organizationId)

      await prisma.$transaction((tx: any) =>
        revokeUserAccess(tx, { userId: user.id, organizationId: s.organizationId, reason: 'deactivated' }),
      )

      const after = await systemPrisma.flow.findUnique({ where: { id: flow.id } })
      assert.ok(after, 'the flow survives — an admin claims it, it is not destroyed')
      assert.ok(after.quarantinedAt, 'and it is quarantined')
      assert.equal(after.status, 'ACTIVE', 'status is untouched so a claim restores nothing wrongly')
    } finally {
      await s.cleanup()
    }
  })

  test('revocation reports the upstream grants still needing deletion', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const { user } = await seedMemberWithEverything(s.organizationId)

      const result = await prisma.$transaction((tx: any) =>
        revokeUserAccess(tx, { userId: user.id, organizationId: s.organizationId, reason: 'deactivated' }),
      )

      assert.deepEqual(result.pendingUpstreamRevokes, [{ connectionId: `conn-${user.id}`, providerConfigKey: 'slack' }])
    } finally {
      await s.cleanup()
    }
  })

  test('org-owned rows are untouched — a workspace does not lose its shared connections', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const { user } = await seedMemberWithEverything(s.organizationId)
      await systemPrisma.mcpConnection.create({ data: { organizationId: s.organizationId, userId: null, name: 'shared', serverUrl: 'https://example.com/mcp' } })

      await prisma.$transaction((tx: any) =>
        revokeUserAccess(tx, { userId: user.id, organizationId: s.organizationId, reason: 'deactivated' }),
      )

      assert.equal(await systemPrisma.mcpConnection.count({ where: { organizationId: s.organizationId, userId: null } }), 1)
    } finally {
      await s.cleanup()
    }
  })

  test('revocation is idempotent', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const { user } = await seedMemberWithEverything(s.organizationId)
      const params = { userId: user.id, organizationId: s.organizationId, reason: 'deactivated' as const }

      await prisma.$transaction((tx: any) => revokeUserAccess(tx, params))
      const second = await prisma.$transaction((tx: any) => revokeUserAccess(tx, params))

      assert.equal(second.credentials.integration, 0, 'a re-run revokes nothing and does not throw')
    } finally {
      await s.cleanup()
    }
  })
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/__tests__/revoke-user-access.db.test.ts`
Expected: FAIL — cannot resolve `../revoke-user-access`.

- [ ] **Step 3: Implement**

Create `src/lib/revoke-user-access.ts`:

```ts
import type { GuardedTransactionClient } from '@/lib/prisma'

/**
 * Revoke everything one person holds in one workspace.
 *
 * Deprovisioning used to be identity-only — `isActive: false` plus a banned
 * session — while every credential stayed live. The OAuth grants outlived the
 * account at the provider, and scheduled work kept running under whichever
 * colleague the scheduler picked next.
 *
 * REVOKE, don't re-home, and QUARANTINE, don't delete. Credentials are removed
 * because the person is gone; the work they built is kept because other teams
 * depend on it, and an admin claims it (see the claim queue). Destroying it
 * would turn a security fix into an outage.
 *
 * Runs inside the caller's transaction so a user is never left deactivated but
 * still holding credentials. The upstream Nango deletion is deliberately NOT
 * done here: it is a network call, and an admin suspending a hostile account
 * must never be blocked by a vendor outage. The returned
 * `pendingUpstreamRevokes` is what the caller enqueues.
 */

export type RevocationReason = 'member_removed' | 'deactivated' | 'scim_deprovisioned' | 'org_transfer'

export interface RevocationResult {
  credentials: {
    integration: number
    peopleAiConnection: number
    mcpConnection: number
    nangoConnection: number
    pushSubscription: number
  }
  apiKeysRevoked: number
  quarantined: { flows: number; agentTasks: number }
  /** Grants still live at the provider. The caller enqueues one job per entry. */
  pendingUpstreamRevokes: Array<{ connectionId: string; providerConfigKey: string }>
}

export async function revokeUserAccess(
  tx: GuardedTransactionClient,
  params: { userId: string; organizationId: string; reason: RevocationReason },
): Promise<RevocationResult> {
  const { userId, organizationId } = params
  const scope = { organizationId, userId }
  const now = new Date()

  // Read the Nango rows BEFORE deleting them — once gone, there is no record of
  // which upstream grants still need deleting.
  const nangoRows = await tx.nangoConnection.findMany({
    where: scope,
    select: { connectionId: true, providerConfigKey: true },
  })

  // Every delete is org-scoped AND user-scoped, so the tenant guard is satisfied
  // and a bug here can only touch this one person in this one workspace.
  // `userId` in the scope is what keeps org-owned rows (userId: null) — shared
  // MCP servers, workspace Nango connections — out of the blast radius.
  const [integration, peopleAiConnection, mcpConnection, nangoConnection, pushSubscription] = await Promise.all([
    tx.integration.deleteMany({ where: scope }),
    tx.peopleAiConnection.deleteMany({ where: scope }),
    tx.mcpConnection.deleteMany({ where: scope }),
    tx.nangoConnection.deleteMany({ where: scope }),
    tx.pushSubscription.deleteMany({ where: scope }),
  ])

  // These already fail closed at authentication (public-api/auth.ts re-checks
  // isActive). Marking them revoked is what makes a credential inventory honest.
  const apiKeys = await tx.apiKey.updateMany({
    where: { ...scope, revokedAt: null },
    data: { revokedAt: now },
  })

  const [flows, agentTasks] = await Promise.all([
    tx.flow.updateMany({ where: { ...scope, quarantinedAt: null }, data: { quarantinedAt: now } }),
    tx.agentTask.updateMany({ where: { ...scope, quarantinedAt: null }, data: { quarantinedAt: now } }),
  ])

  return {
    credentials: {
      integration: integration.count,
      peopleAiConnection: peopleAiConnection.count,
      mcpConnection: mcpConnection.count,
      nangoConnection: nangoConnection.count,
      pushSubscription: pushSubscription.count,
    },
    apiKeysRevoked: apiKeys.count,
    quarantined: { flows: flows.count, agentTasks: agentTasks.count },
    pendingUpstreamRevokes: nangoRows,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/__tests__/revoke-user-access.db.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Verify gates and commit**

```bash
npm run typecheck && npm run lint
git add src/lib/revoke-user-access.ts src/lib/__tests__/revoke-user-access.db.test.ts
git commit -m "feat(revocation): revokeUserAccess removes credentials and quarantines owned work"
```

---

### Task 7: Upstream revoke via the outbox

Deletes the grant at Nango, retried durably, with a record when it never lands.

**Files:**
- Modify: `src/lib/outbox.ts` (`deliver` at line 83, and the terminal branch of `processOutboxBatch`)
- Create: `src/lib/nango/revoke-connection.ts`
- Test: `src/lib/__tests__/credential-revoke-outbox.test.ts`

Note the drain lives in `outbox.ts` itself — `deliver()` — not in `dispatch-tick.ts`. `processOutboxBatch` is called from both the scheduler tick and the worker, so registering the topic in `deliver` covers both automatically.

**Interfaces:**
- Consumes: `RevocationResult.pendingUpstreamRevokes` from Task 6.
- Produces:
  - `OUTBOX_TOPIC_CREDENTIAL_REVOKE = 'credential.revoke'`
  - `credentialRevokeOutboxEvent(input: { organizationId: string; connectionId: string; providerConfigKey: string; userId: string }): { organizationId: string; topic: string; aggregateId: string; dedupeKey: string; payload: Prisma.InputJsonValue }`
  - `handleCredentialRevoke(organizationId: string, payload: unknown): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/credential-revoke-outbox.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { credentialRevokeOutboxEvent, OUTBOX_TOPIC_CREDENTIAL_REVOKE } from '../outbox'

test('a credential revoke event carries what the drain needs to delete the grant', () => {
  const event = credentialRevokeOutboxEvent({
    organizationId: 'org-1',
    connectionId: 'conn-abc',
    providerConfigKey: 'slack',
    userId: 'user-1',
  })

  assert.equal(event.topic, OUTBOX_TOPIC_CREDENTIAL_REVOKE)
  assert.equal(event.organizationId, 'org-1')
  assert.deepEqual(event.payload, { connectionId: 'conn-abc', providerConfigKey: 'slack', userId: 'user-1' })
})

test('the dedupe key is the connection, so a double revocation enqueues once', () => {
  // Unlike provider events, a revoke HAS a natural idempotency key: deleting the
  // same grant twice is meaningless, and the unique index makes it impossible.
  const first = credentialRevokeOutboxEvent({ organizationId: 'org-1', connectionId: 'conn-abc', providerConfigKey: 'slack', userId: 'user-1' })
  const second = credentialRevokeOutboxEvent({ organizationId: 'org-1', connectionId: 'conn-abc', providerConfigKey: 'slack', userId: 'user-1' })

  assert.equal(first.dedupeKey, second.dedupeKey)
  assert.match(first.dedupeKey, /conn-abc/)
})

test('the aggregate id is the connection id, so a failed row identifies the live grant', () => {
  // On exhaustion the failed outbox row IS the record that a grant is still out
  // there. It has to name the grant.
  const event = credentialRevokeOutboxEvent({ organizationId: 'org-1', connectionId: 'conn-abc', providerConfigKey: 'slack', userId: 'user-1' })

  assert.equal(event.aggregateId, 'conn-abc')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/__tests__/credential-revoke-outbox.test.ts`
Expected: FAIL — `credentialRevokeOutboxEvent` is not exported.

- [ ] **Step 3: Add the topic and builder**

In `src/lib/outbox.ts`, beside `OUTBOX_TOPIC_FLOW_SIGNAL`:

```ts
export const OUTBOX_TOPIC_CREDENTIAL_REVOKE = 'credential.revoke'
```

and add the builder:

```ts
/**
 * Deleting a revoked user's OAuth grant at Nango, durably.
 *
 * Not done inline during deprovisioning on purpose: it is a network call, and
 * an admin suspending a hostile account must never be blocked by a vendor
 * outage. The local revocation commits immediately; this catches up.
 *
 * On exhaustion the row survives in `failed` status carrying the connection id
 * — that row IS the record that a grant is still live upstream, which is what
 * makes an un-revoked credential visible instead of silent.
 */
export function credentialRevokeOutboxEvent(input: {
  organizationId: string
  connectionId: string
  providerConfigKey: string
  userId: string
}) {
  return {
    organizationId: input.organizationId,
    topic: OUTBOX_TOPIC_CREDENTIAL_REVOKE,
    aggregateId: input.connectionId,
    // A revoke HAS a natural idempotency key, unlike provider events: deleting
    // the same grant twice is meaningless.
    dedupeKey: `credential-revoke:${input.connectionId}`,
    payload: {
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      userId: input.userId,
    } as Prisma.InputJsonValue,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/__tests__/credential-revoke-outbox.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the drain handler**

Create `src/lib/nango/revoke-connection.ts`:

```ts
import { z } from 'zod'
import { getNangoClient, nangoConfigured } from './client'
import { recordAudit } from '@/lib/audit'

/**
 * Delete one OAuth grant at Nango. Throwing is how the outbox learns to retry,
 * so failures must NOT be swallowed here.
 */

const payloadSchema = z.object({
  connectionId: z.string().min(1),
  providerConfigKey: z.string().min(1),
  userId: z.string().min(1),
})

export async function handleCredentialRevoke(organizationId: string, payload: unknown): Promise<void> {
  const { connectionId, providerConfigKey, userId } = payloadSchema.parse(payload)

  // Nothing to revoke upstream in an install with no Nango — treat as done
  // rather than retrying eight times against a client that cannot exist.
  if (!nangoConfigured()) return

  await getNangoClient().deleteConnection(providerConfigKey, connectionId)

  await recordAudit({
    organizationId,
    action: 'credential.revoked',
    actorKind: 'system',
    actorUserId: userId,
    resourceType: 'nango_connection',
    resourceId: connectionId,
    detail: { providerConfigKey, upstream: true },
  })
}
```

- [ ] **Step 6: Register the handler in the drain**

In `src/lib/outbox.ts`, `deliver` currently rejects every topic but one (line 83). Replace it with a dispatch:

```ts
async function deliver(event: { id: string; organizationId: string; topic: string; payload: Prisma.JsonValue }) {
  if (event.topic === OUTBOX_TOPIC_CREDENTIAL_REVOKE) {
    const { handleCredentialRevoke } = await import('@/lib/nango/revoke-connection')
    await handleCredentialRevoke(event.organizationId, event.payload)
    return
  }
  if (event.topic !== OUTBOX_TOPIC_FLOW_SIGNAL) throw new Error(`Unsupported outbox topic: ${event.topic}`)
  const signal = parseSignalPayload(event.payload)
  const { emitFlowSignal } = await import('@/features/flows/signals')
  await emitFlowSignal({ ...signal, organizationId: event.organizationId, deliveryId: event.id, strictDelivery: true })
}
```

The dynamic `import()` matches how `emitFlowSignal` is already loaded here, keeping the Nango client out of the module graph for callers that never drain.

- [ ] **Step 7: Record exhaustion**

In `processOutboxBatch`'s catch block, immediately after the `systemPrisma.outboxEvent.update` that writes the terminal state, add:

```ts
      if (terminal && event.topic === OUTBOX_TOPIC_CREDENTIAL_REVOKE) {
        // The grant is STILL LIVE at the provider. The failed row carries the
        // connection id in aggregateId, so this is recoverable rather than lost
        // — but it has to be VISIBLE. A silently un-revoked OAuth grant is the
        // exact thing this sub-project exists to make impossible.
        await recordAudit({
          organizationId: event.organizationId,
          action: 'credential.revoke_failed',
          actorKind: 'system',
          resourceType: 'nango_connection',
          resourceId: event.aggregateId,
          detail: { attempts, lastError: message },
        })
      }
```

Note it reads the local `attempts` and `message` (in scope in that block), not `event.attempts` — the row's own counter is one behind, since the claim incremented it in the database rather than on this object.

Add `import { recordAudit } from '@/lib/audit'` at the top of `src/lib/outbox.ts`.

The candidate query in `processOutboxBatch` has no `select`, so `event.aggregateId` is already available with no change.

- [ ] **Step 8: Verify gates and commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/lib/outbox.ts src/lib/nango/revoke-connection.ts src/lib/scheduling/dispatch-tick.ts src/lib/__tests__/credential-revoke-outbox.test.ts
git commit -m "feat(revocation): delete the upstream OAuth grant via the outbox"
```

---

### Task 8: Wire every deprovision path

The four paths that deactivate someone, plus `org-transfer` folded in so there is one revocation implementation rather than two that drift.

**Files:**
- Modify: `src/app/api/organizations/members/[id]/route.ts` (DELETE handler)
- Modify: `src/app/api/admin/users/[id]/actions/route.ts` (`deactivate` branch)
- Modify: `src/app/api/scim/v2/Users/[id]/route.ts` (PATCH `active:false`, DELETE)
- Modify: `src/lib/org-transfer.ts`
- Test: `src/app/api/__tests__/deprovision-revokes.db.test.ts`

**Interfaces:**
- Consumes: `revokeUserAccess` (Task 6), `credentialRevokeOutboxEvent` (Task 7).
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/__tests__/deprovision-revokes.db.test.ts` covering each path. Because the four handlers differ in authentication, test the shared shape by asserting on the effect of the extracted helper each one calls. Add:

```ts
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

/**
 * Every deprovision path must revoke. This is the regression net for the
 * original bug: org-transfer HAD the revocation logic and deactivation simply
 * never called it.
 */

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let systemPrisma: any
  let seedTestOrg: any
  let deprovisionUser: any

  before(async () => {
    ;({ prisma, systemPrisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg } = await import('@/lib/server/__tests__/test-auth'))
    ;({ deprovisionUser } = await import('@/lib/revoke-user-access'))
  })

  test('deprovisioning deactivates AND revokes in one transaction', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const user = await systemPrisma.user.create({
        data: { supabaseId: crypto.randomUUID(), email: `x-${crypto.randomUUID()}@example.com`, organizationId: s.organizationId },
      })
      await systemPrisma.integration.create({ data: { organizationId: s.organizationId, userId: user.id, provider: 'slack' } })

      await deprovisionUser({ userId: user.id, organizationId: s.organizationId, reason: 'deactivated', actorUserId: s.userId })

      const after = await systemPrisma.user.findUnique({ where: { id: user.id } })
      assert.equal(after.isActive, false)
      assert.equal(await systemPrisma.integration.count({ where: { userId: user.id } }), 0)
    } finally {
      await s.cleanup()
    }
  })

  test('deprovisioning writes an audit row — removing someone left no trace before', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const user = await systemPrisma.user.create({
        data: { supabaseId: crypto.randomUUID(), email: `y-${crypto.randomUUID()}@example.com`, organizationId: s.organizationId },
      })

      await deprovisionUser({ userId: user.id, organizationId: s.organizationId, reason: 'member_removed', actorUserId: s.userId })

      const events = await systemPrisma.auditEvent.findMany({
        where: { organizationId: s.organizationId, action: 'member.deprovisioned', resourceId: user.id },
      })
      assert.equal(events.length, 1)
      assert.equal((events[0].detail as any).reason, 'member_removed')
    } finally {
      await s.cleanup()
    }
  })
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/deprovision-revokes.db.test.ts`
Expected: FAIL — `deprovisionUser` is not exported.

- [ ] **Step 3: Add the orchestrating helper**

Append to `src/lib/revoke-user-access.ts`:

```ts
import { prisma } from '@/lib/prisma'
import { recordAudit } from '@/lib/audit'
import { credentialRevokeOutboxEvent } from '@/lib/outbox'

/**
 * Deactivate + revoke + enqueue the upstream deletions, atomically.
 *
 * Every deprovision path calls THIS, not revokeUserAccess directly, so no path
 * can deactivate without revoking. That is the failure this whole sub-project
 * exists to close: the revocation logic already existed in org-transfer.ts, and
 * deactivation just never called it.
 *
 * Does NOT touch Supabase — session banning differs per caller (the operator
 * console bans before flipping the column; SCIM bans as part of its own update)
 * and belongs to them.
 */
export async function deprovisionUser(params: {
  userId: string
  organizationId: string
  reason: RevocationReason
  actorUserId?: string | null
}): Promise<RevocationResult> {
  const { userId, organizationId, reason, actorUserId } = params

  const result = await prisma.$transaction(async (tx) => {
    const revocation = await revokeUserAccess(tx, { userId, organizationId, reason })

    await tx.user.update({ where: { id: userId }, data: { isActive: false } })

    // Enqueued in the SAME transaction as the local revocation, so there is no
    // window where the row is gone but nothing remembers to delete the grant.
    for (const grant of revocation.pendingUpstreamRevokes) {
      await tx.outboxEvent.create({
        data: credentialRevokeOutboxEvent({ organizationId, userId, ...grant }),
      })
    }

    return revocation
  })

  await recordAudit({
    organizationId,
    action: 'member.deprovisioned',
    actorUserId: actorUserId ?? null,
    resourceType: 'user',
    resourceId: userId,
    detail: {
      reason,
      credentials: result.credentials,
      apiKeysRevoked: result.apiKeysRevoked,
      quarantined: result.quarantined,
      upstreamRevokesQueued: result.pendingUpstreamRevokes.length,
    },
  })

  // A separate row, not just a field on the one above: the claim queue is an
  // operational surface, and "what got quarantined and when" is the question an
  // admin asks weeks later without wanting to reconstruct a deprovisioning.
  if (result.quarantined.flows > 0 || result.quarantined.agentTasks > 0) {
    await recordAudit({
      organizationId,
      action: 'work.quarantined',
      actorUserId: actorUserId ?? null,
      resourceType: 'user',
      resourceId: userId,
      detail: { reason, ...result.quarantined },
    })
  }

  return result
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/deprovision-revokes.db.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Replace the bare `isActive: false` writes in all four paths**

In `src/app/api/organizations/members/[id]/route.ts`, the DELETE handler — replace:

```ts
  await prisma.user.update({ where: { id: target.id }, data: { isActive: false } })
  return { success: true }
```

with:

```ts
  const revocation = await deprovisionUser({
    userId: target.id,
    organizationId: auth.organizationId,
    reason: 'member_removed',
    actorUserId: auth.dbUser.id,
  })
  return { success: true, revocation }
```

In `src/app/api/admin/users/[id]/actions/route.ts`, the `deactivate` branch — keep the Supabase ban first, since its ordering comment still applies:

```ts
      await supabaseAdmin()
        .updateUserById(target.supabaseId, { ban_duration: FOREVER })
        .catch(() => {
          throw new ApiError('Could not deactivate the account in Supabase.', 502, 'SUPABASE_ERROR')
        })
      if (target.organizationId) {
        await deprovisionUser({
          userId: target.id,
          organizationId: target.organizationId,
          reason: 'deactivated',
          actorUserId: auth.userId,
        })
      } else {
        // No workspace means no org-scoped credentials to revoke.
        await systemPrisma.user.update({ where: { id: target.id }, data: { isActive: false } })
      }
      await audit({})
      return { success: true, isActive: false }
```

In `src/app/api/scim/v2/Users/[id]/route.ts`, PATCH — after the Supabase update and before the final `user.update`, intercept the deactivation case so it revokes rather than merely flipping the column:

```ts
  if (data.isActive === false) {
    const { deprovisionUser } = await import('@/lib/revoke-user-access')
    await deprovisionUser({
      userId: existing.id,
      organizationId: auth.organizationId,
      reason: 'scim_deprovisioned',
      actorUserId: null,
    })
    // isActive is now set; leave it out so the update below cannot re-assert it
    // against a row deprovisionUser already wrote.
    delete data.isActive
  }
  const updated = await systemPrisma.user.update({ where: { id: existing.id }, data })
  return scimJson(scimUser(updated))
```

and DELETE:

```ts
export async function DELETE(request: Request) {
  const auth = await authenticateScim(request)
  if (auth instanceof Response) return auth
  const existing = await ownedUser(request, auth.organizationId)
  if (!existing) return new Response(null, { status: 204 })
  if (isPlatformOwnerEmail(existing.email)) return scimError('This account is the platform owner and cannot be deleted.', 403)
  await supabaseAdmin().updateUserById(existing.supabaseId, { ban_duration: '876000h' }).catch(() => undefined)
  const { deprovisionUser } = await import('@/lib/revoke-user-access')
  await deprovisionUser({
    userId: existing.id,
    organizationId: auth.organizationId,
    reason: 'scim_deprovisioned',
    actorUserId: null,
  })
  return new Response(null, { status: 204 })
}
```

SCIM has no acting user — the caller is a provisioning token — so `actorUserId` is null and `actorKind` stays the audit default. The dynamic import keeps `@/lib/prisma`'s guarded client out of the SCIM module's top-level graph, matching how the file already defers `supabaseAdmin`.

- [ ] **Step 6: Fold org-transfer into the shared implementation**

In `src/lib/org-transfer.ts`, replace the five inline `deleteMany` calls with `revokeUserAccess(tx, { userId, organizationId: fromOrganizationId, reason: 'org_transfer' })`, mapping its `RevocationResult.credentials` onto the existing `TransferResult.revoked` shape so callers are unaffected.

This also fixes a latent bug: `REVOKED_ON_TRANSFER` never included `nangoConnection`, so a transferred user's Nango connection stayed in the workspace they left. Add `'nangoConnection'` to the exported constant and to `TransferResult.revoked`.

Note that transfer must NOT quarantine — the person is moving, not leaving. Pass a flag or, more simply, let transfer call `revokeUserAccess` and then clear the quarantine stamps it set:

```ts
  // A transfer is not a deprovisioning: the person is still employed, so their
  // work in the old workspace keeps its owner and keeps running.
  await Promise.all([
    tx.flow.updateMany({ where: { organizationId: fromOrganizationId, userId }, data: { quarantinedAt: null } }),
    tx.agentTask.updateMany({ where: { organizationId: fromOrganizationId, userId }, data: { quarantinedAt: null } }),
  ])
```

- [ ] **Step 7: Run the full suite and gates**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all PASS. Existing org-transfer tests must still pass unchanged.

- [ ] **Step 8: Commit**

```bash
git add src/lib/revoke-user-access.ts src/lib/org-transfer.ts "src/app/api/organizations/members/[id]/route.ts" "src/app/api/admin/users/[id]/actions/route.ts" "src/app/api/scim/v2/Users/[id]/route.ts" src/app/api/__tests__/deprovision-revokes.db.test.ts
git commit -m "feat(revocation): every deprovision path revokes credentials"
```

---

### Task 9: The claim queue

Quarantined work must be recoverable in one action, or this ships an outage. The queue is derived from `quarantinedAt` — no new model.

**Files:**
- Create: `src/app/api/quarantine/route.ts` (GET the queue)
- Create: `src/app/api/quarantine/[id]/claim/route.ts` (POST a claim)
- Create: `src/lib/quarantine.ts`
- Create: `src/components/settings/quarantine-panel.tsx`
- Modify: `src/app/settings/page.tsx` (render the panel)
- Modify: `src/app/api/admin/users/[id]/actions/route.ts` (`reactivate` notice)
- Modify: `src/app/admin/users/page.tsx` (surface the notice)
- Test: `src/app/api/__tests__/quarantine-claim.db.test.ts`

**Interfaces:**
- Consumes: `Flow.quarantinedAt`, `AgentTask.quarantinedAt` (Task 1).
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/__tests__/quarantine-claim.db.test.ts`:

```ts
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let systemPrisma: any
  let seedTestOrg: any
  let claimQuarantinedWork: any
  let listQuarantinedWork: any

  before(async () => {
    ;({ prisma, systemPrisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg } = await import('@/lib/server/__tests__/test-auth'))
    ;({ claimQuarantinedWork, listQuarantinedWork } = await import('@/lib/quarantine'))
  })

  test('the queue lists quarantined work with its former owner', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const former = await systemPrisma.user.create({
        data: { supabaseId: crypto.randomUUID(), email: `gone-${crypto.randomUUID()}@example.com`, organizationId: s.organizationId, isActive: false },
      })
      await systemPrisma.flow.create({
        data: { organizationId: s.organizationId, userId: former.id, name: 'orphaned', status: 'ACTIVE', quarantinedAt: new Date() },
      })

      const queue = await listQuarantinedWork(s.organizationId)

      assert.equal(queue.length, 1)
      assert.equal(queue[0].name, 'orphaned')
      assert.equal(queue[0].formerOwnerEmail, former.email)
    } finally {
      await s.cleanup()
    }
  })

  test('claiming rebinds the owner and clears the quarantine, leaving status alone', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const former = await systemPrisma.user.create({
        data: { supabaseId: crypto.randomUUID(), email: `gone2-${crypto.randomUUID()}@example.com`, organizationId: s.organizationId, isActive: false },
      })
      const flow = await systemPrisma.flow.create({
        data: { organizationId: s.organizationId, userId: former.id, name: 'orphaned', status: 'DRAFT', quarantinedAt: new Date() },
      })

      await claimQuarantinedWork({ organizationId: s.organizationId, kind: 'flow', id: flow.id, claimantUserId: s.userId })

      const after = await systemPrisma.flow.findUnique({ where: { id: flow.id } })
      assert.equal(after.userId, s.userId, 'it runs as the claimant now')
      assert.equal(after.quarantinedAt, null)
      assert.equal(after.status, 'DRAFT', 'a quarantined DRAFT must not come back ACTIVE')
    } finally {
      await s.cleanup()
    }
  })

  test('claiming writes an audit row', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const flow = await systemPrisma.flow.create({
        data: { organizationId: s.organizationId, userId: null, name: 'orphaned', status: 'ACTIVE', quarantinedAt: new Date() },
      })

      await claimQuarantinedWork({ organizationId: s.organizationId, kind: 'flow', id: flow.id, claimantUserId: s.userId })

      const events = await systemPrisma.auditEvent.findMany({
        where: { organizationId: s.organizationId, action: 'work.claimed', resourceId: flow.id },
      })
      assert.equal(events.length, 1)
    } finally {
      await s.cleanup()
    }
  })
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/quarantine-claim.db.test.ts`
Expected: FAIL — cannot resolve `@/lib/quarantine`.

- [ ] **Step 3: Implement the queue module**

Create `src/lib/quarantine.ts`:

```ts
import { prisma } from '@/lib/prisma'
import { recordAudit } from '@/lib/audit'

/**
 * Work whose owner was deprovisioned.
 *
 * Quarantine is what keeps a security fix from becoming an outage: the flows a
 * suspended person built often matter to other teams, so they are stopped and
 * made VISIBLE rather than deleted or silently re-owned. An admin claims one
 * and it resumes under their identity and their credentials.
 *
 * The queue is DERIVED from `quarantinedAt` — no separate model to drift.
 */

export type QuarantinedKind = 'flow' | 'agent'

export interface QuarantinedItem {
  kind: QuarantinedKind
  id: string
  name: string
  quarantinedAt: Date
  formerOwnerEmail: string | null
}

export async function listQuarantinedWork(organizationId: string): Promise<QuarantinedItem[]> {
  const [flows, agents] = await Promise.all([
    prisma.flow.findMany({
      where: { organizationId, quarantinedAt: { not: null } },
      select: { id: true, name: true, quarantinedAt: true, user: { select: { email: true } } },
      orderBy: { quarantinedAt: 'desc' },
    }),
    prisma.agentTask.findMany({
      where: { organizationId, quarantinedAt: { not: null } },
      select: { id: true, description: true, quarantinedAt: true, user: { select: { email: true } } },
      orderBy: { quarantinedAt: 'desc' },
    }),
  ])

  return [
    ...flows.map((row) => ({
      kind: 'flow' as const,
      id: row.id,
      name: row.name,
      quarantinedAt: row.quarantinedAt!,
      formerOwnerEmail: row.user?.email ?? null,
    })),
    ...agents.map((row) => ({
      kind: 'agent' as const,
      id: row.id,
      name: row.description,
      quarantinedAt: row.quarantinedAt!,
      formerOwnerEmail: row.user?.email ?? null,
    })),
  ].sort((a, b) => b.quarantinedAt.getTime() - a.quarantinedAt.getTime())
}

/**
 * Take ownership. Rebinds `userId` and clears the stamp — `status` is
 * deliberately untouched, because quarantine never wrote it and a claimed draft
 * must not come back active.
 */
export async function claimQuarantinedWork(params: {
  organizationId: string
  kind: QuarantinedKind
  id: string
  claimantUserId: string
}): Promise<void> {
  const { organizationId, kind, id, claimantUserId } = params
  const where = { id, organizationId, quarantinedAt: { not: null } }
  const data = { userId: claimantUserId, quarantinedAt: null }

  const updated =
    kind === 'flow'
      ? await prisma.flow.updateMany({ where, data })
      : await prisma.agentTask.updateMany({ where, data })

  if (updated.count === 0) return

  await recordAudit({
    organizationId,
    action: 'work.claimed',
    actorUserId: claimantUserId,
    resourceType: kind,
    resourceId: id,
  })
}
```

Note: `listQuarantinedWork` reads `Flow`/`AgentTask`, which are NOT in the owner-liveness registry, so the former owner's email resolves normally even though they are inactive. That is intentional — the queue's whole job is naming who left.

- [ ] **Step 4: Run the test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/quarantine-claim.db.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Add the routes**

Create `src/app/api/quarantine/route.ts`:

```ts
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { listQuarantinedWork } from '@/lib/quarantine'

export const GET = withAuthenticatedApi(
  async (_request, auth) => ({ items: await listQuarantinedWork(auth.organizationId) }),
  { permission: 'members.manage' },
)
```

Create `src/app/api/quarantine/[id]/claim/route.ts`:

```ts
import { z } from 'zod'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { claimQuarantinedWork } from '@/lib/quarantine'

const bodySchema = z.object({ kind: z.enum(['flow', 'agent']) })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2) ?? ''
  const { kind } = bodySchema.parse(await request.json())
  await claimQuarantinedWork({ organizationId: auth.organizationId, kind, id, claimantUserId: auth.dbUser.id })
  return { success: true }
}, { permission: 'members.manage' })
```

Verify `members.manage` exists in `src/lib/authz/permissions.ts`; it is the permission the member-removal route already uses, so an admin who can deprovision can also recover the work.

- [ ] **Step 6: Add the panel**

Create `src/components/settings/quarantine-panel.tsx`:

```tsx
'use client'

/**
 * Settings → work orphaned by deprovisioning.
 *
 * When someone is deprovisioned their credentials are revoked, and the flows
 * and agents they owned are quarantined rather than deleted or silently handed
 * to whoever the scheduler picked next. Other teams often depend on that work,
 * so the stoppage has to be VISIBLE and one click from repair — otherwise a
 * security fix reads as an unexplained outage.
 *
 * Claiming rebinds the work to you: it resumes under your identity and your
 * credentials, which is the only attribution that is honest after the original
 * owner is gone.
 */

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

type QuarantinedRow = {
  kind: 'flow' | 'agent'
  id: string
  name: string
  quarantinedAt: string
  formerOwnerEmail: string | null
}

export function QuarantinePanel() {
  const [items, setItems] = useState<QuarantinedRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [claiming, setClaiming] = useState<string | null>(null)

  const load = useCallback(async () => {
    const response = await fetch('/api/quarantine')
    if (!response.ok) return setLoaded(true)
    const data = await response.json()
    setItems(data.items ?? [])
    setLoaded(true)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const claim = async (row: QuarantinedRow) => {
    setClaiming(row.id)
    try {
      const response = await fetch(`/api/quarantine/${row.id}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: row.kind }),
      })
      if (!response.ok) throw new Error('Could not claim it')
      toast.success(`You now own “${row.name}”. It runs with your credentials.`)
      await load()
    } catch {
      toast.error('Could not claim that. Try again.')
    } finally {
      setClaiming(null)
    }
  }

  // An exception surface: a permanent empty card is noise on a page nobody
  // visits looking for it.
  if (!loaded || items.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle>Work that needs an owner</CardTitle>
        <CardDescription>
          These stopped when the person who owned them was removed. Claiming one starts it running again
          under your account, using your connected credentials.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.map((row) => (
          <div key={`${row.kind}:${row.id}`} className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div className="min-w-0">
              <p className="truncate font-medium">{row.name}</p>
              <p className="text-sm text-muted-foreground">
                {row.kind === 'flow' ? 'Flow' : 'Agent'}
                {row.formerOwnerEmail ? ` · previously ${row.formerOwnerEmail}` : ''}
                {` · stopped ${new Date(row.quarantinedAt).toLocaleDateString()}`}
              </p>
            </div>
            <Button onClick={() => claim(row)} disabled={claiming === row.id}>
              {claiming === row.id ? 'Claiming…' : 'Claim'}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
```

Render `<QuarantinePanel />` in `src/app/settings/page.tsx` alongside the existing sections.

- [ ] **Step 6b: Say that reactivation does not restore access**

Reactivating a user does NOT give their integrations back — the upstream grant was deleted, so they must reconnect each provider. This is correct, but it reads as a bug to anyone who does not expect it.

In `src/app/api/admin/users/[id]/actions/route.ts`, the `reactivate` branch returns a flag the console can surface:

```ts
      await systemPrisma.user.update({ where: { id: target.id }, data: { isActive: true } })
      await audit({})
      return {
        success: true,
        isActive: true,
        // Deactivation deleted the OAuth grants at the provider, not just our
        // copy. There is nothing to restore, so the operator has to know the
        // person will land in an app with no integrations connected.
        credentialsRestored: false,
        notice: 'Their integrations were revoked when the account was deactivated. They will need to reconnect each one.',
      }
```

In `src/app/admin/users/page.tsx`, show `notice` in the success toast for the reactivate action rather than a bare "Reactivated".

- [ ] **Step 7: Verify gates and commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/lib/quarantine.ts src/app/api/quarantine src/components/settings/quarantine-panel.tsx src/app/settings/page.tsx "src/app/api/admin/users/[id]/actions/route.ts" src/app/admin/users/page.tsx src/app/api/__tests__/quarantine-claim.db.test.ts
git commit -m "feat(revocation): claim queue for work orphaned by deprovisioning"
```

---

## Verification

After Task 9, confirm the whole spine end-to-end:

- [ ] `npm run typecheck && npm run lint && npm test` all pass.
- [ ] Reproduce the original bug and confirm it is closed: seed a user with a Nango connection and an ACTIVE scheduled flow, deprovision them, then assert the connection row is gone, an outbox `credential.revoke` row exists, the flow carries `quarantinedAt`, and `resolveRunOwners` omits it.
- [ ] Confirm the CI-mode gate passes against a local Postgres (`ci_repro`), since the `.db.test.ts` files added here only execute when `TEST_DATABASE_URL` is set and are otherwise silently skipped locally.
