# RBAC and Catalogue Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the platform a staff/partner/customer identity tier and a permission registry, then put a staff review gate in front of everything that reaches the shared template catalogue.

**Architecture:** Two independent axes resolve to one permission set — org role (VIEWER/USER/ADMIN/OWNER) and platform tier (`Organization.kind` + `User.platformRole`). A pure `resolvePermissions()` computes the set; `withAuthenticatedApi({ permission })` enforces it at the single wrapper 89 of 100 route files already use. Publishing stops being a client-settable `visibility` field and becomes a reviewer action on a frozen `CatalogueSubmission` snapshot, which writes into the existing template tables owned by the Backstory internal org.

**Tech Stack:** Next.js App Router, Prisma 6 + PostgreSQL (Supabase), Zod, Supabase Auth, `node:test` + `tsx`, Tailwind.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-29-rbac-and-catalogue-publishing-design.md`. Read it before Task 1.
- **No raw token syntax in UI.** Never render `{{brackets}}` anywhere user-visible. Plain-English labels and explicit validation messages only.
- **Tenant guard.** Every new org-carrying model is registered in `ORG_SCOPED_MODELS` (`src/lib/tenant-guard.ts`). Deliberate cross-org reads use `systemPrisma` with a one-line justification comment.
- **Local gate:** `npm run typecheck && npm run lint` must pass before every commit. `npm run build` will 500 locally (no Supabase env vars) — that is by design; builds validate on Vercel.
- **DB tests** are skipped without `TEST_DATABASE_URL`. CI provides it. Reproduce CI mode locally against the `ci_repro` Postgres before pushing.
- **Single test file:** `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <path>`. Full suite: `npm test`.
- **Migrations** are applied in production with `prisma migrate deploy`; write migration SQL by hand under `prisma/migrations/<timestamp>_<name>/migration.sql`.
- **Commit style:** conventional prefix, imperative subject describing behavior, not mechanics.
- **Ordering note:** the spec's build sequence lists the permission registry first; this plan puts the schema migration first, because `resolvePermissions` is typed against the widened `UserRole` enum. Everything else follows the spec's order, and the "steps 1–3 close the hole before any UI exists" property is unchanged.

---

### Task 1: Schema — platform tiers, catalogue status, submissions

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260730000000_rbac_role_values/migration.sql`
- Create: `prisma/migrations/20260730000100_catalogue_submissions/migration.sql`
- Create: `supabase/catalogue-submission-rls.sql`
- Modify: `src/lib/tenant-guard.ts:30-37`
- Test: `src/lib/__tests__/catalogue-schema.db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma model `CatalogueSubmission`; `Organization.kind: string`; `User.platformRole: string | null`; `UserRole` enum values `OWNER` and `VIEWER`; `AgentTemplate.catalogueStatus`, `FlowTemplate.catalogueStatus`, `SharedSkill.visibility`, `SharedSkill.catalogueStatus` — all `string`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/catalogue-schema.db.test.ts`:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

/**
 * The RBAC + catalogue schema against a real database: the new columns exist
 * with the documented defaults, and the legacy backfill left already-published
 * rows visible. Skipped without TEST_DATABASE_URL; CI provides it.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const org = await prisma.organization.create({
      data: { name: 'schema check', slug: `schema-${crypto.randomUUID()}` },
    })
    ids.org = org.id
    const user = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), organizationId: org.id, isActive: true },
    })
    ids.user = user.id
  })

  after(async () => {
    if (ids.org) await prisma.organization.delete({ where: { id: ids.org } }).catch(() => {})
  })

  test('a new organization defaults to kind=customer and users have no platform role', async () => {
    const org = await prisma.organization.findUnique({ where: { id: ids.org } })
    assert.equal(org.kind, 'customer')
    const user = await prisma.user.findUnique({ where: { id: ids.user } })
    assert.equal(user.platformRole, null)
  })

  test('UserRole accepts the two new values', async () => {
    const viewer = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), organizationId: ids.org, isActive: true, role: 'VIEWER' },
    })
    assert.equal(viewer.role, 'VIEWER')
    const owner = await prisma.user.update({ where: { id: viewer.id }, data: { role: 'OWNER' } })
    assert.equal(owner.role, 'OWNER')
  })

  test('templates and skills default to catalogueStatus=none and skills to org visibility', async () => {
    const template = await prisma.agentTemplate.create({
      data: { name: 't', type: 'Custom', userId: ids.user, organizationId: ids.org },
    })
    assert.equal(template.catalogueStatus, 'none')
    assert.equal(template.visibility, 'org')

    const skill = await prisma.sharedSkill.create({
      data: { name: 's', instructions: 'do a thing', organizationId: ids.org },
    })
    assert.equal(skill.visibility, 'org')
    assert.equal(skill.catalogueStatus, 'none')
  })

  test('a submission stores a frozen snapshot and is org-scoped', async () => {
    const submission = await prisma.catalogueSubmission.create({
      data: {
        kind: 'agent_template',
        title: 'Weekly pipeline digest',
        summary: 'Summarises pipeline movement every Monday.',
        snapshot: { name: 'Weekly pipeline digest' },
        organizationId: ids.org,
        submittedByUserId: ids.user,
      },
    })
    assert.equal(submission.status, 'pending')
    assert.deepEqual(submission.snapshot, { name: 'Weekly pipeline digest' })

    // The tenant guard must reject an unscoped read of the new model.
    await assert.rejects(
      () => prisma.catalogueSubmission.findFirst({ where: { id: submission.id } }),
      /organizationId/,
    )
  })
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/__tests__/catalogue-schema.db.test.ts`
Expected: FAIL — `Unknown argument 'kind'` / `prisma.catalogueSubmission is not a function`.

- [ ] **Step 3: Add the schema changes**

In `prisma/schema.prisma`, add to `model Organization` (after `plan`):

```prisma
  /// Platform tier. 'internal' = Backstory; 'partner' = People.ai; 'customer'
  /// = every paying workspace. Only a platform reviewer may change this — it
  /// is never settable from a customer-facing route.
  kind             String    @default("customer")
```

Add to the `Organization` relation block: `catalogueSubmissions CatalogueSubmission[]`.

Add to `model User` (after `role`):

```prisma
  /// Platform tier, independent of the org role. null for everyone outside
  /// Backstory. 'staff' = internal employee; 'reviewer' = may decide and
  /// publish catalogue submissions.
  platformRole   String?
```

Extend the enum:

```prisma
enum UserRole {
  ADMIN
  USER
  OWNER
  VIEWER
}
```

Add to `model AgentTemplate` and `model FlowTemplate` (after `visibility`):

```prisma
  /// 'none' = not in the catalogue; 'published' = approved through review;
  /// 'legacy_published' = was global before review existed, pending audit.
  catalogueStatus String  @default("none")
```

Add to `model SharedSkill` (after `authorName`):

```prisma
  /// 'org' = this workspace only; 'global' = published to the shared library.
  /// Before the review gate every skill was implicitly global; the migration
  /// backfills existing rows to 'global' + catalogueStatus 'legacy_published'.
  visibility     String   @default("org")
  catalogueStatus String  @default("none")
```

Add the new model next to `TemplateProposal`:

```prisma
/// An author's request to publish an artifact to the shared catalogue.
/// `snapshot` is FROZEN at submit time: it is what a reviewer reads and what
/// gets published, so edits the author makes afterward cannot reach a
/// published entry without a fresh submission.
model CatalogueSubmission {
  id                String    @id @default(cuid())
  /// 'flow_template' | 'agent_template' | 'shared_skill'
  kind              String
  /// 'pending' | 'changes_requested' | 'approved' | 'rejected' | 'withdrawn'
  status            String    @default("pending")
  title             String
  summary           String    @db.Text
  snapshot          Json
  /// The author's own row this was snapshotted from. Informational — the
  /// snapshot is authoritative and the source may be edited or deleted.
  sourceId          String?
  /// The SUBMITTING org, which is what makes this row org-scoped.
  organizationId    String    @db.Uuid
  submittedByUserId String
  reviewerUserId    String?
  reviewNote        String?   @db.Text
  decidedAt         DateTime?
  /// The published row created on approve.
  publishedEntryId  String?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([status, createdAt])
  @@index([organizationId, status])
  @@map("catalogue_submissions")
}
```

- [ ] **Step 4: Write the enum migration**

`ALTER TYPE ... ADD VALUE` cannot be used in the same transaction that adds it, so the enum change gets its own migration file ahead of everything that might reference it.

Create `prisma/migrations/20260730000000_rbac_role_values/migration.sql`:

```sql
-- Two new org roles. USER is deliberately NOT renamed to MEMBER: it remains
-- the member tier, so no row is rewritten and the free-text Invitation.role
-- values ('ADMIN' | 'USER') stay valid without a backfill.
--
-- Own migration file: Postgres forbids USING a new enum value in the same
-- transaction that adds it, and Prisma runs each migration in one transaction.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'OWNER';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'VIEWER';
```

- [ ] **Step 5: Write the main migration**

Create `prisma/migrations/20260730000100_catalogue_submissions/migration.sql`:

```sql
-- Platform tiers + the catalogue review gate.

ALTER TABLE "organizations" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'customer';
ALTER TABLE "users" ADD COLUMN "platformRole" TEXT;

ALTER TABLE "agent_templates" ADD COLUMN "catalogueStatus" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "flow_templates"  ADD COLUMN "catalogueStatus" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "shared_skills"   ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'org';
ALTER TABLE "shared_skills"   ADD COLUMN "catalogueStatus" TEXT NOT NULL DEFAULT 'none';

-- Grandfather what is already published so the catalogue does not empty on
-- deploy. Staff audit these through the Legacy tab and retire them there.
UPDATE "agent_templates" SET "catalogueStatus" = 'legacy_published' WHERE "visibility" = 'global';
UPDATE "flow_templates"  SET "catalogueStatus" = 'legacy_published' WHERE "visibility" = 'global';
-- Every shared skill was public-by-construction before this migration.
UPDATE "shared_skills"   SET "visibility" = 'global', "catalogueStatus" = 'legacy_published';

CREATE TABLE "catalogue_submissions" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "snapshot" JSONB NOT NULL,
  "sourceId" TEXT,
  "organizationId" UUID NOT NULL,
  "submittedByUserId" TEXT NOT NULL,
  "reviewerUserId" TEXT,
  "reviewNote" TEXT,
  "decidedAt" TIMESTAMP(3),
  "publishedEntryId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "catalogue_submissions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "catalogue_submissions_status_createdAt_idx"
  ON "catalogue_submissions"("status", "createdAt");
CREATE INDEX "catalogue_submissions_organizationId_status_idx"
  ON "catalogue_submissions"("organizationId", "status");

ALTER TABLE "catalogue_submissions"
  ADD CONSTRAINT "catalogue_submissions_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 6: Write the RLS policy**

Create `supabase/catalogue-submission-rls.sql`, mirroring the structural posture of `supabase/flow-jam-rls.sql` — Postgres enforces the org boundary independently of the Prisma guard:

```sql
-- Catalogue submissions: a member reads and writes only their own workspace's
-- submissions. Reviewers (users.platformRole = 'reviewer') read every row —
-- the queue is cross-org by design, and this is the one place that is true.

alter table public.catalogue_submissions enable row level security;

create policy catalogue_submissions_own_org
  on public.catalogue_submissions
  for all
  using (
    "organizationId" in (
      select "organizationId" from public.users
      where "supabaseId" = auth.uid() and "isActive" = true
    )
  )
  with check (
    "organizationId" in (
      select "organizationId" from public.users
      where "supabaseId" = auth.uid() and "isActive" = true
    )
  );

create policy catalogue_submissions_reviewer_read
  on public.catalogue_submissions
  for select
  using (
    exists (
      select 1 from public.users
      where "supabaseId" = auth.uid() and "isActive" = true and "platformRole" = 'reviewer'
    )
  );
```

- [ ] **Step 7: Register the model with the tenant guard**

In `src/lib/tenant-guard.ts`, add `'CatalogueSubmission'` to the `ORG_SCOPED_MODELS` set, on the line that already lists `'TemplateProposal', 'StoredFile',`:

```ts
  'TemplateProposal', 'StoredFile', 'CatalogueSubmission',
```

- [ ] **Step 8: Generate the client and run the test**

Run: `npx prisma generate && TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/__tests__/catalogue-schema.db.test.ts`
Expected: PASS, 4 tests.

Then run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations supabase/catalogue-submission-rls.sql \
  src/lib/tenant-guard.ts src/lib/__tests__/catalogue-schema.db.test.ts
git commit -m "feat(rbac): platform tiers and a submission record for the catalogue"
```

---

### Task 2: The permission registry

**Files:**
- Create: `src/lib/authz/permissions.ts`
- Test: `src/lib/authz/__tests__/permissions.test.ts`

**Interfaces:**
- Consumes: `UserRole` from `@prisma/client` (Task 1).
- Produces:
  - `PERMISSIONS: readonly Permission[]`
  - `type Permission`
  - `resolvePermissions(user: PermissionUser, org: PermissionOrg): ReadonlySet<Permission>`
  - `type PermissionUser = { role: UserRole; platformRole: string | null }`
  - `type PermissionOrg = { kind: string }`

- [ ] **Step 1: Write the failing test**

Create `src/lib/authz/__tests__/permissions.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PERMISSIONS, resolvePermissions } from '../permissions'

const customer = { kind: 'customer' }
const partner = { kind: 'partner' }
const internal = { kind: 'internal' }
const member = { role: 'USER' as const, platformRole: null }
const admin = { role: 'ADMIN' as const, platformRole: null }
const viewer = { role: 'VIEWER' as const, platformRole: null }
const reviewer = { role: 'ADMIN' as const, platformRole: 'reviewer' }

test('a viewer reads but cannot write, run, or author', () => {
  const p = resolvePermissions(viewer, customer)
  assert.ok(p.has('flow.read'))
  assert.ok(p.has('agent.read'))
  assert.ok(!p.has('flow.write'))
  assert.ok(!p.has('flow.run'))
  assert.ok(!p.has('template.author'))
})

test('role bundles are cumulative', () => {
  const m = resolvePermissions(member, customer)
  assert.ok(m.has('flow.read') && m.has('flow.write') && m.has('template.author'))
  assert.ok(!m.has('members.manage'))

  const a = resolvePermissions(admin, customer)
  assert.ok(a.has('flow.write')) // inherited from USER
  assert.ok(a.has('members.manage') && a.has('integration.manage') && a.has('audit.read'))

  const o = resolvePermissions({ role: 'OWNER', platformRole: null }, customer)
  assert.ok(o.has('members.manage') && o.has('org.manage'))
})

test('a customer admin can never submit or review, whatever their org role', () => {
  for (const role of ['VIEWER', 'USER', 'ADMIN', 'OWNER'] as const) {
    const p = resolvePermissions({ role, platformRole: null }, customer)
    assert.ok(!p.has('template.submit'), role)
    assert.ok(!p.has('catalogue.review'), role)
    assert.ok(!p.has('catalogue.publish'), role)
    assert.ok(!p.has('catalogue.takedown'), role)
  }
})

test('a partner member may submit but not review', () => {
  const p = resolvePermissions(member, partner)
  assert.ok(p.has('template.submit'))
  assert.ok(!p.has('catalogue.review'))
  assert.ok(!p.has('catalogue.publish'))
})

test('internal orgs may submit; only a reviewer decides and publishes', () => {
  const staff = resolvePermissions({ role: 'USER', platformRole: 'staff' }, internal)
  assert.ok(staff.has('template.submit'))
  assert.ok(!staff.has('catalogue.review'))

  const r = resolvePermissions(reviewer, internal)
  assert.ok(r.has('catalogue.review') && r.has('catalogue.publish') && r.has('catalogue.takedown'))
})

test('the platform overlay is independent of the org role', () => {
  // A reviewer who is only a VIEWER in their workspace still reviews.
  const p = resolvePermissions({ role: 'VIEWER', platformRole: 'reviewer' }, internal)
  assert.ok(p.has('catalogue.review'))
  assert.ok(!p.has('flow.write'))
})

test('a reviewer flag on a customer org grants nothing (defence in depth)', () => {
  const p = resolvePermissions({ role: 'ADMIN', platformRole: 'reviewer' }, customer)
  assert.ok(!p.has('catalogue.review'))
  assert.ok(!p.has('template.submit'))
})

test('every resolved permission is a declared one', () => {
  const declared = new Set<string>(PERMISSIONS)
  for (const org of [customer, partner, internal]) {
    for (const role of ['VIEWER', 'USER', 'ADMIN', 'OWNER'] as const) {
      for (const platformRole of [null, 'staff', 'reviewer']) {
        for (const perm of resolvePermissions({ role, platformRole }, org)) {
          assert.ok(declared.has(perm), `${perm} is not in PERMISSIONS`)
        }
      }
    }
  }
})
```

Note the seventh test: a `platformRole` of `'reviewer'` on a `customer` org grants nothing. That guard matters because `platformRole` and `kind` are separately settable, and a stale flag on a moved user must not become a cross-tenant hole.

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/authz/__tests__/permissions.test.ts`
Expected: FAIL — `Cannot find module '../permissions'`.

- [ ] **Step 3: Write the registry**

Create `src/lib/authz/permissions.ts`:

```ts
/**
 * The permission registry: the single source of truth for what a caller may do.
 *
 * Before this, authorization was ~9 inline `role === 'ADMIN'` comparisons
 * scattered across routes and components, with no way to express a
 * platform-level tier at all. Now every route declares the permission it needs
 * (`withAuthenticatedApi(handler, { permission })`) and this module decides who
 * holds it.
 *
 * Two INDEPENDENT axes union together:
 *   - the org role  — what you may do inside your own workspace
 *   - the platform tier — whether you are Backstory, People.ai, or a customer
 *
 * Roles are fixed bundles. Orgs cannot define their own, and permissions are
 * not grantable on individual resources; both were considered and deliberately
 * left out (see the spec's non-goals).
 */
import type { UserRole } from '@prisma/client'

export const PERMISSIONS = [
  'flow.read', 'flow.write', 'flow.run',
  'agent.read', 'agent.write', 'agent.run',
  'integration.manage', 'members.manage', 'org.manage', 'audit.read',
  'template.author', 'template.submit',
  'catalogue.review', 'catalogue.publish', 'catalogue.takedown',
] as const

export type Permission = (typeof PERMISSIONS)[number]

export type PermissionUser = { role: UserRole; platformRole: string | null }
export type PermissionOrg = { kind: string }

/** Org kinds whose members may propose entries to the shared catalogue. */
const SUBMITTING_ORG_KINDS = new Set(['internal', 'partner'])

// Cumulative bundles: each role adds to the one above it.
const VIEWER_PERMISSIONS: Permission[] = ['flow.read', 'agent.read']
const MEMBER_PERMISSIONS: Permission[] = [
  ...VIEWER_PERMISSIONS,
  'flow.write', 'flow.run', 'agent.write', 'agent.run', 'template.author',
]
const ADMIN_PERMISSIONS: Permission[] = [
  ...MEMBER_PERMISSIONS,
  'integration.manage', 'members.manage', 'org.manage', 'audit.read',
]

const BY_ROLE: Record<UserRole, Permission[]> = {
  VIEWER: VIEWER_PERMISSIONS,
  USER: MEMBER_PERMISSIONS,
  ADMIN: ADMIN_PERMISSIONS,
  // OWNER is ADMIN today. It exists so billing and workspace deletion have a
  // tier to land on without another enum migration.
  OWNER: ADMIN_PERMISSIONS,
}

/**
 * The permissions held by `user` acting inside `org`.
 *
 * Pure: no DB access, no env reads, no clock. The whole role × org-kind matrix
 * is therefore unit-testable without a database.
 */
export function resolvePermissions(user: PermissionUser, org: PermissionOrg): ReadonlySet<Permission> {
  const granted = new Set<Permission>(BY_ROLE[user.role] ?? VIEWER_PERMISSIONS)

  // Platform overlay. Both checks are gated on the ORG kind as well as the
  // user's flag: a reviewer who moves to a customer workspace loses review
  // rights immediately, without anyone having to remember to clear the flag.
  const submittingOrg = SUBMITTING_ORG_KINDS.has(org.kind)
  if (submittingOrg) granted.add('template.submit')
  if (submittingOrg && user.platformRole === 'reviewer') {
    granted.add('catalogue.review')
    granted.add('catalogue.publish')
    granted.add('catalogue.takedown')
  }

  return granted
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/authz/__tests__/permissions.test.ts`
Expected: PASS, 8 tests.

Then: `npm run typecheck && npm run lint` — both clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/authz
git commit -m "feat(rbac): one registry decides what a caller may do"
```

---

### Task 3: Wire permissions into the auth context and the API wrapper

**Files:**
- Modify: `src/lib/server/auth.ts`
- Modify: `src/lib/server/api-handler.ts:26-35`
- Modify: `src/lib/supabase/auth-utils.ts`
- Modify: `src/lib/server/__tests__/test-auth.ts`
- Test: `src/lib/server/__tests__/permission-gate.test.ts`

**Interfaces:**
- Consumes: `resolvePermissions`, `Permission` (Task 2); `Organization.kind`, `User.platformRole` (Task 1).
- Produces:
  - `AuthContext` gains `permissions: ReadonlySet<Permission>` and `can(permission: Permission): boolean`.
  - `withAuthenticatedApi(handler, options)` where `options` gains `permission?: Permission`.
  - `AuthContextError` code `'PERMISSION_DENIED'` at status 403.
  - `seedTestOrg(prisma, overrides?)` where `overrides` is `{ orgKind?: string; role?: UserRole; platformRole?: string | null }`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/server/__tests__/permission-gate.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { withAuthenticatedApi } from '../api-handler'
import { setTestAuthContext } from '../auth'
import { resolvePermissions } from '@/lib/authz/permissions'
import type { AuthContext } from '../auth'

function contextFor(role: 'USER' | 'ADMIN', orgKind: string, platformRole: string | null): AuthContext {
  const permissions = resolvePermissions({ role, platformRole }, { kind: orgKind })
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    dbUser: { id: 'user-1', role, platformRole } as never,
    user: { id: 'sb-1' } as never,
    permissions,
    can: (permission) => permissions.has(permission),
  }
}

// The seam requires a non-production NODE_ENV and TEST_DATABASE_URL; this
// suite drives the wrapper only, so a dummy value is enough.
process.env.TEST_DATABASE_URL ??= 'postgresql://unused/permission-gate'

const request = () => new NextRequest(new URL('http://test/api/thing'))

test('a handler with no declared permission still runs', async () => {
  setTestAuthContext(contextFor('USER', 'customer', null))
  const handler = withAuthenticatedApi(async () => ({ success: true }))
  assert.equal((await handler(request())).status, 200)
  setTestAuthContext(null)
})

test('a satisfied permission lets the handler run', async () => {
  setTestAuthContext(contextFor('USER', 'customer', null))
  const handler = withAuthenticatedApi(async () => ({ success: true }), { permission: 'flow.write' })
  assert.equal((await handler(request())).status, 200)
  setTestAuthContext(null)
})

test('an unsatisfied permission 403s with PERMISSION_DENIED before the handler runs', async () => {
  setTestAuthContext(contextFor('ADMIN', 'customer', null))
  let ran = false
  const handler = withAuthenticatedApi(
    async () => { ran = true; return { success: true } },
    { permission: 'catalogue.review' },
  )
  const response = await handler(request())
  assert.equal(response.status, 403)
  const body = await response.json()
  assert.equal(body.code, 'PERMISSION_DENIED')
  assert.equal(body.detail?.required, 'catalogue.review')
  assert.equal(ran, false, 'the handler must not run when the gate rejects')
  setTestAuthContext(null)
})

test('a reviewer in an internal org passes the same gate', async () => {
  setTestAuthContext(contextFor('ADMIN', 'internal', 'reviewer'))
  const handler = withAuthenticatedApi(async () => ({ success: true }), { permission: 'catalogue.review' })
  assert.equal((await handler(request())).status, 200)
  setTestAuthContext(null)
})

test('auth.can mirrors the resolved set', () => {
  const ctx = contextFor('USER', 'partner', null)
  assert.equal(ctx.can('template.submit'), true)
  assert.equal(ctx.can('catalogue.publish'), false)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/server/__tests__/permission-gate.test.ts`
Expected: FAIL — `AuthContext` has no `permissions`/`can`, and `withAuthenticatedApi` rejects the `permission` option.

- [ ] **Step 3: Extend AuthContext**

In `src/lib/server/auth.ts`, add the import and widen the interface:

```ts
import { resolvePermissions, type Permission } from '@/lib/authz/permissions'
```

```ts
export interface AuthContext {
  user: AuthResult['user']
  dbUser: NonNullable<AuthResult['dbUser']>
  userId: string
  organizationId: string
  /** Everything this caller may do, resolved once per request. */
  permissions: ReadonlySet<Permission>
  can(permission: Permission): boolean
}
```

Add the error helper below `assertEntitled`:

```ts
/** Throws 403 PERMISSION_DENIED, naming the permission the caller lacked. */
export class PermissionDeniedError extends AuthContextError {
  constructor(readonly required: Permission) {
    super('You do not have permission to do that.', 403, 'PERMISSION_DENIED')
    this.name = 'PermissionDeniedError'
  }
}
```

At the end of `requireAuthContext`, replace the return with:

```ts
  // `getAuthWithUser` already includes the organization on dbUser, so resolving
  // permissions costs no extra query.
  const organization = auth.dbUser.organization
  const permissions = resolvePermissions(
    { role: auth.dbUser.role, platformRole: auth.dbUser.platformRole },
    { kind: organization?.kind ?? 'customer' },
  )

  return {
    user: auth.user,
    dbUser: auth.dbUser,
    userId: auth.userId,
    organizationId: auth.organizationId,
    permissions,
    can: (permission) => permissions.has(permission),
  }
```

- [ ] **Step 4: Gate the wrapper**

In `src/lib/server/api-handler.ts`, import the error and widen the options:

```ts
import { AuthContextError, PermissionDeniedError, requireAuthContext, type AuthContext } from './auth'
import type { Permission } from '@/lib/authz/permissions'
```

```ts
export function withAuthenticatedApi(
  handler: AuthenticatedHandler,
  options?: { skipBackstoryGate?: boolean; skipEntitlementGate?: boolean; permission?: Permission },
) {
  return async (request: NextRequest): Promise<Response> => {
    try {
      const auth = await requireAuthContext(options)
      // The gate runs BEFORE the handler, so a rejected call has no side effects.
      if (options?.permission && !auth.can(options.permission)) {
        throw new PermissionDeniedError(options.permission)
      }
      const result = await handler(request, auth)
      ...
```

In the `AuthContextError` catch branch, carry the required permission so a 403 is debuggable:

```ts
      if (error instanceof AuthContextError) {
        return NextResponse.json(
          {
            success: false,
            error: error.message,
            code: error.code,
            ...(error instanceof PermissionDeniedError && { detail: { required: error.required } }),
          },
          { status: error.status },
        )
      }
```

- [ ] **Step 5: Teach the test seam about permissions**

Replace `src/lib/server/__tests__/test-auth.ts` with:

```ts
import crypto from 'node:crypto'
import { setTestAuthContext } from '../auth'
import type { AuthContext } from '../auth'
import { resolvePermissions } from '@/lib/authz/permissions'
import type { UserRole } from '@prisma/client'

export interface SeedOverrides {
  /** 'customer' (default) | 'partner' | 'internal' */
  orgKind?: string
  role?: UserRole
  platformRole?: string | null
}

/** Seed an org + active user and return an AuthContext bound to them. */
export async function seedTestOrg(
  prisma: any,
  overrides: SeedOverrides = {},
): Promise<{ organizationId: string; userId: string; auth: AuthContext; cleanup: () => Promise<void> }> {
  const org = await prisma.organization.create({
    data: { name: 'Smoke', slug: `smoke-${crypto.randomUUID()}`, kind: overrides.orgKind ?? 'customer' },
  })
  const user = await prisma.user.create({
    data: {
      supabaseId: crypto.randomUUID(),
      organizationId: org.id,
      isActive: true,
      role: overrides.role ?? 'ADMIN',
      platformRole: overrides.platformRole ?? null,
    },
  })
  const permissions = resolvePermissions(
    { role: user.role, platformRole: user.platformRole },
    { kind: org.kind },
  )
  const auth: AuthContext = {
    organizationId: org.id,
    userId: user.id,
    dbUser: user,
    user: { id: user.supabaseId } as never,
    permissions,
    can: (permission) => permissions.has(permission),
  }
  const cleanup = async () => {
    setTestAuthContext(null)
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {})
  }
  return { organizationId: org.id, userId: user.id, auth, cleanup }
}

export function installTestAuth(auth: AuthContext): void {
  setTestAuthContext(auth)
}
export function clearTestAuth(): void {
  setTestAuthContext(null)
}
```

The default `role` moves from Prisma's `USER` default to `ADMIN` so the existing smoke suite keeps reaching admin-gated routes once Task 4 declares them. That is deliberate: the smoke suite asserts routes are reachable, not that they are gated.

- [ ] **Step 6: Add the staff bootstrap**

In `src/lib/supabase/auth-utils.ts`, add above `getAuthWithUser`:

```ts
/**
 * Recovery path for platform staff: addresses listed in PLATFORM_STAFF_EMAILS
 * are promoted to reviewer on sign-in, and their workspace is marked internal.
 * Idempotent, and a no-op for everyone else. Once one reviewer exists, further
 * grants happen in /admin/catalogue — this env var only has to solve the
 * bootstrap problem of granting the first one.
 */
async function applyStaffBootstrap(dbUser: NonNullable<DbUserRow>): Promise<NonNullable<DbUserRow>> {
  const allowlist = (process.env.PLATFORM_STAFF_EMAILS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  const email = dbUser.email?.trim().toLowerCase()
  if (!email || !allowlist.includes(email)) return dbUser
  if (dbUser.platformRole === 'reviewer' && dbUser.organization?.kind === 'internal') return dbUser

  const updated = await prisma.user.update({
    where: { id: dbUser.id },
    data: { platformRole: 'reviewer' },
    include: { organization: true },
  })
  // Drop the cached row in BOTH branches: the cache is keyed on supabaseId and
  // holds the pre-promotion user for up to a minute otherwise, so the first
  // request after promotion would still resolve customer-tier permissions.
  invalidateAuthCache(dbUser.supabaseId)

  if (updated.organizationId && updated.organization?.kind !== 'internal') {
    await prisma.organization.update({
      where: { id: updated.organizationId },
      data: { kind: 'internal' },
    })
    return { ...updated, organization: { ...updated.organization!, kind: 'internal' } }
  }
  return updated
}
```

In `getAuthWithUser`, wrap the resolved user:

```ts
  const resolved = (await findDbUserCached(user.id)) ?? (await provisionUser(user))
  const dbUser = resolved ? await applyStaffBootstrap(resolved) : resolved
```

- [ ] **Step 7: Run the tests**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/server/__tests__/permission-gate.test.ts`
Expected: PASS, 5 tests.

Run the full suite to catch `AuthContext` construction sites the widened interface broke:
Run: `npm test`
Expected: PASS. Any failure will be a test building an `AuthContext` literal without `permissions`/`can` — fix it by routing through `seedTestOrg`.

Then: `npm run typecheck && npm run lint`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/server src/lib/supabase/auth-utils.ts
git commit -m "feat(rbac): resolve permissions per request and gate routes on them"
```

---

### Task 4: Declare permissions across existing routes

This task changes no behavior: every current member is `USER` or `ADMIN`, and both already satisfy the permissions their routes allowed. It exists so authorization is declared in one readable place per route rather than implied.

**Files:**
- Modify: ~89 route files under `src/app/api/**/route.ts`
- Test: `src/app/api/__tests__/permission-coverage.test.ts`

**Interfaces:**
- Consumes: `withAuthenticatedApi(handler, { permission })` (Task 3).
- Produces: an exemption list constant `UNGATED_ROUTES: readonly string[]` exported from the test file's sibling module `src/lib/authz/ungated-routes.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/authz/ungated-routes.ts`:

```ts
/**
 * Route files that deliberately do NOT go through withAuthenticatedApi.
 *
 * Each is unauthenticated or authenticated by another mechanism (a cron
 * secret, an OAuth callback's state parameter, an HMAC-signed webhook, or a
 * per-resource trigger token). Adding to this list is a security decision, so
 * the coverage test fails when it grows without the list being updated.
 */
export const UNGATED_ROUTES: readonly string[] = [
  'cron/retention',                       // CRON_SECRET header
  'cron/dispatch',                        // CRON_SECRET header
  'invitations/lookup',                   // pre-auth: resolves an invite token
  'health',                               // public liveness probe
  'peopleai/callback',                    // OAuth redirect, validated by state
  'mcp-connections/oauth/callback',       // OAuth redirect, validated by state
  'flows/[id]/trigger',                   // per-flow trigger token
  'flows/[id]/runs/[runId]/resume',       // per-run resume token
  'signals/people-ai',                    // HMAC-signed webhook
  'nango/webhook',                        // HMAC-signed webhook
  'agents/[id]/trigger',                  // per-agent trigger token
]
```

Create `src/app/api/__tests__/permission-coverage.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { UNGATED_ROUTES } from '@/lib/authz/ungated-routes'

const apiDir = path.dirname(fileURLToPath(import.meta.url)).replace(/\/__tests__$/, '')

function routeFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__') continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) routeFiles(full, acc)
    else if (entry === 'route.ts') acc.push(full)
  }
  return acc
}

const files = routeFiles(apiDir)
const relative = (file: string) => path.relative(apiDir, file).replace(/\/route\.ts$/, '')

test('every route either goes through the auth wrapper or is a declared exemption', () => {
  const exempt = new Set(UNGATED_ROUTES)
  const unexplained = files
    .filter((file) => !readFileSync(file, 'utf8').includes('withAuthenticatedApi'))
    .map(relative)
    .filter((route) => !exempt.has(route))

  assert.deepEqual(unexplained, [], `these routes bypass auth without being declared in UNGATED_ROUTES: ${unexplained.join(', ')}`)
})

test('the exemption list has no stale entries', () => {
  const actual = new Set(files.map(relative))
  const stale = UNGATED_ROUTES.filter((route) => !actual.has(route))
  assert.deepEqual(stale, [], `UNGATED_ROUTES names routes that no longer exist: ${stale.join(', ')}`)
})

test('every wrapped route declares the permission it needs', () => {
  const missing = files
    .filter((file) => {
      const source = readFileSync(file, 'utf8')
      return source.includes('withAuthenticatedApi') && !source.includes('permission:')
    })
    .map(relative)

  assert.deepEqual(missing, [], `these routes are authenticated but declare no permission: ${missing.join(', ')}`)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/permission-coverage.test.ts`
Expected: FAIL on the third test, listing ~89 routes with no declared permission.

- [ ] **Step 3: Declare the permission on each route**

Work through the list the failing test printed. Map each route to the permission it already effectively required:

| Route group | Permission |
| --- | --- |
| `flows`, `flows/[id]`, `flows/tool-*`, `flow-templates` GET | `flow.read` |
| `flows` POST/PUT/DELETE, `flows/[id]/publish`, `flows/[id]/share` | `flow.write` |
| `flows/[id]/run`, `flows/[id]/runs/*` (non-token) | `flow.run` |
| `agents` GET, `agents/activity`, `executions`, `workflows` | `agent.read` |
| `agents` POST/PUT/DELETE, `agents/[id]/*` config | `agent.write` |
| `agents/[id]/run`, `chat`, `approvals` POST | `agent.run` |
| `agent-templates`, `flow-templates`, `templates`, `skills`, `template-proposals` writes | `template.author` |
| `integrations/*`, `nango/*` (non-webhook), `mcp-connections/*`, `http-credentials`, `peopleai/*`, `granola` | `integration.manage` |
| `organizations/members*`, `organizations/invitations`, `invitations/*` | `members.manage` |
| `organizations`, `settings`-backing routes, `setup/*` | `org.manage` |
| `audit/*` | `audit.read` |

Read-only GETs on templates and skills stay at `flow.read`/`agent.read` — browsing the catalogue is not authoring.

Apply the option at each export. For example, in `src/app/api/flow-templates/route.ts`:

```ts
export const GET = withAuthenticatedApi(async (request, auth) => {
  ...
}, { permission: 'flow.read' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  ...
}, { permission: 'template.author' })
```

Where a route already passes options, add the key rather than replacing the object:

```ts
}, { skipEntitlementGate: true, permission: 'org.manage' })
```

- [ ] **Step 4: Run the coverage test and the full suite**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/permission-coverage.test.ts`
Expected: PASS, 3 tests.

Run: `TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro npm test`
Expected: PASS. The route smoke suite in `src/app/api/__tests__/route-smoke.test.ts` is the real check here — it drives ~30 GET routes through the wrapper and asserts each returns < 500. A 403 there means a permission was mapped too tightly; re-read the table above.

Then: `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/app/api src/lib/authz/ungated-routes.ts
git commit -m "feat(rbac): every route declares the permission it requires"
```

---

### Task 5: Make catalogue visibility server-controlled

This is the task that closes the live hole. After it, no request body can put a row in the shared catalogue.

**Files:**
- Modify: `src/app/api/flow-templates/route.ts:25,58,82`
- Modify: `src/app/api/agent-templates/route.ts:22,58,98`
- Test: `src/app/api/__tests__/visibility-is-server-controlled.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `createTemplate` and `createFlowTemplate` keep their `visibility` parameter — they are the seam Task 8's publish path writes `'global'` through.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/__tests__/visibility-is-server-controlled.test.ts`:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { NextRequest } from 'next/server'

const apiDir = path.dirname(fileURLToPath(import.meta.url)).replace(/\/__tests__$/, '')

// A static guard: this is the regression that let any workspace publish, and
// it must not be reintroduced by a future schema edit.
test('no template route accepts visibility from a request body', () => {
  for (const route of ['flow-templates/route.ts', 'agent-templates/route.ts']) {
    const source = readFileSync(path.join(apiDir, route), 'utf8')
    assert.ok(
      !/visibility:\s*z\./.test(source),
      `${route} declares visibility in a Zod schema — publishing must be server-controlled`,
    )
    assert.ok(
      !/body\.visibility|data\.visibility/.test(source),
      `${route} reads visibility from the request body`,
    )
  }
})

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  const post = (body: unknown) =>
    new NextRequest(new URL('http://test/api/agent-templates'), {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    })

  test('a template created with visibility=global in the body is still org-scoped', async () => {
    const { POST } = await import('../agent-templates/route')
    const response = await POST(post({
      name: 'Sneaky publish',
      category: 'Custom',
      configuration: { instructions: 'do a thing' },
      visibility: 'global',
    }))
    assert.equal(response.status, 200)
    const row = await prisma.agentTemplate.findFirst({
      where: { organizationId: seeded.organizationId, name: 'Sneaky publish' },
    })
    assert.equal(row.visibility, 'org')
    assert.equal(row.catalogueStatus, 'none')
  })
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/visibility-is-server-controlled.test.ts`
Expected: FAIL on the static guard — both routes declare `visibility: z.enum(['org', 'global']).optional()`.

- [ ] **Step 3: Remove visibility from the client surface**

In `src/app/api/flow-templates/route.ts`, delete line 25 (`visibility: z.enum(['org', 'global']).optional(),`) from `templateSchema`.

Replace the `POST` body's visibility argument (line 58) with:

```ts
    // Catalogue visibility is SERVER-controlled: a template is org-scoped until
    // a reviewer publishes it from an approved CatalogueSubmission. There is no
    // request body that can put a row in the shared catalogue.
    visibility: 'org',
```

Delete the `PUT` passthrough at line 82 (`...(body.visibility !== undefined && { visibility: body.visibility }),`) entirely.

Apply the identical three edits to `src/app/api/agent-templates/route.ts` at lines 22, 58, and 98.

- [ ] **Step 4: Run the test to verify it passes**

Run: `TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/visibility-is-server-controlled.test.ts`
Expected: PASS, 2 tests.

Run: `TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro npm test`
Expected: PASS. If a UI component posts `visibility`, the extra key is now ignored rather than rejected — Zod strips unknown keys by default, so no client change is required yet.

Then: `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/flow-templates/route.ts src/app/api/agent-templates/route.ts \
  src/app/api/__tests__/visibility-is-server-controlled.test.ts
git commit -m "fix(catalogue): a request body can no longer publish to the shared catalogue"
```

---

### Task 6: Gate the shared skill library

`GET /api/skills` returns every `SharedSkill` row in the database to every workspace, and `POST` writes straight into that library. This is the widest of the three holes.

**Files:**
- Modify: `src/app/api/skills/route.ts:45-60`
- Test: `src/app/api/skills/__tests__/visibility.db.test.ts`

**Interfaces:**
- Consumes: `SharedSkill.visibility`, `SharedSkill.catalogueStatus` (Task 1).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/skills/__tests__/visibility.db.test.ts`:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

/**
 * The skill library's tenancy boundary: a workspace sees its own skills at any
 * visibility plus other workspaces' PUBLISHED ones, and never another
 * workspace's org-scoped ones.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any
  let otherOrgId: string

  const mkSkill = (organizationId: string, name: string, visibility: string) =>
    prisma.sharedSkill.create({
      data: { name, instructions: 'do a thing', organizationId, visibility },
    })

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    const other = await prisma.organization.create({
      data: { name: 'other', slug: `other-${crypto.randomUUID()}` },
    })
    otherOrgId = other.id
    await mkSkill(seeded.organizationId, 'mine-org', 'org')
    await mkSkill(otherOrgId, 'theirs-published', 'global')
    await mkSkill(otherOrgId, 'theirs-private', 'org')
  })

  after(async () => {
    if (otherOrgId) await prisma.organization.delete({ where: { id: otherOrgId } }).catch(() => {})
    if (seeded) await seeded.cleanup()
  })

  test('the library shows own skills and other orgs published ones only', async () => {
    const { GET } = await import('../route')
    const response = await GET(new NextRequest(new URL('http://test/api/skills')))
    const body = await response.json()
    const names = body.skills.filter((s: any) => s.custom).map((s: any) => s.name)

    assert.ok(names.includes('mine-org'), 'own org-scoped skill must be visible')
    assert.ok(names.includes('theirs-published'), 'another org published skill must be visible')
    assert.ok(!names.includes('theirs-private'), 'another org org-scoped skill must be hidden')
  })

  test('a newly created skill is org-scoped, not published', async () => {
    const { POST } = await import('../route')
    const response = await POST(new NextRequest(new URL('http://test/api/skills'), {
      method: 'POST',
      body: JSON.stringify({ name: 'fresh', instructions: 'do a thing' }),
      headers: { 'content-type': 'application/json' },
    }))
    assert.equal(response.status, 200)
    const row = await prisma.sharedSkill.findFirst({
      where: { organizationId: seeded.organizationId, name: 'fresh' },
    })
    assert.equal(row.visibility, 'org')
    assert.equal(row.catalogueStatus, 'none')
  })
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/skills/__tests__/visibility.db.test.ts`
Expected: FAIL on the first test — `theirs-private` is visible, because the read has no visibility filter.

- [ ] **Step 3: Split the read into own + published**

In `src/app/api/skills/route.ts`, replace the `GET` handler:

```ts
// GET — built-in skills, this workspace's own skills at any visibility, and
// other workspaces' PUBLISHED ones. Mirrors fetchCatalogueRows: the published
// slice is the only cross-org read.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const own = await prisma.sharedSkill.findMany({
    where: { organizationId: auth.organizationId, isActive: true },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  })
  // systemPrisma: the PUBLISHED community slice from OTHER orgs. Own rows come
  // from the tenant-guarded query above.
  const published = await systemPrisma.sharedSkill.findMany({
    where: { isActive: true, visibility: 'global', NOT: { organizationId: auth.organizationId } },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  })
  return {
    success: true,
    skills: [
      ...[...own, ...published].map((skill) => serializeShared(skill, auth.organizationId)),
      ...listSkills().map((skill) => ({ ...skill, custom: false, mine: false })),
    ],
  }
}, { permission: 'agent.read' })
```

The `POST` handler needs no change — `visibility` now defaults to `'org'` at the schema level, and `skillSchema` never accepted it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/skills/__tests__/visibility.db.test.ts`
Expected: PASS, 2 tests.

Then: `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/skills
git commit -m "fix(skills): the community library shows published skills, not every row"
```

---

### Task 7: The submission API

**Files:**
- Create: `src/lib/catalogue/submissions.ts`
- Create: `src/app/api/catalogue/submissions/route.ts`
- Create: `src/app/api/catalogue/submissions/[id]/route.ts`
- Test: `src/lib/catalogue/__tests__/snapshot.test.ts`
- Test: `src/app/api/catalogue/__tests__/submissions.db.test.ts`

**Interfaces:**
- Consumes: `CatalogueSubmission` (Task 1); `template.submit` permission (Task 2); the wrapper's `permission` option (Task 3).
- Produces:
  - `type SubmissionKind = 'flow_template' | 'agent_template' | 'shared_skill'`
  - `buildSnapshot(kind: SubmissionKind, row: Record<string, unknown>): Record<string, unknown>`
  - `createSubmission(params: CreateSubmissionParams): Promise<CatalogueSubmission>` where `CreateSubmissionParams = { organizationId: string; userId: string; kind: SubmissionKind; sourceId: string; title: string; summary: string }`
  - `GET/POST /api/catalogue/submissions`, `DELETE /api/catalogue/submissions/[id]` (withdraw)

- [ ] **Step 1: Write the failing snapshot test**

Create `src/lib/catalogue/__tests__/snapshot.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSnapshot } from '../submissions'

test('a flow template snapshot carries the executable artifact and its notes', () => {
  const snapshot = buildSnapshot('flow_template', {
    id: 'ft1',
    name: 'Digest',
    description: 'A digest',
    category: 'Reporting',
    graph: { nodes: [], edges: [] },
    notes: { objective: 'o', inputs: [], steps: [], setup: [], customize: [] },
    bindings: [],
    configuration: { tags: ['a'], authorName: 'Rin' },
    organizationId: 'org-1',
    userId: 'user-1',
    createdAt: new Date(),
  })

  assert.equal(snapshot.name, 'Digest')
  assert.deepEqual(snapshot.graph, { nodes: [], edges: [] })
  assert.equal((snapshot.configuration as any).authorName, 'Rin')
})

test('a snapshot never carries tenancy or identity columns', () => {
  const snapshot = buildSnapshot('agent_template', {
    id: 'at1',
    name: 'Digest',
    type: 'Reporting',
    configuration: { instructions: 'do a thing' },
    organizationId: 'org-1',
    userId: 'user-1',
    visibility: 'org',
    catalogueStatus: 'none',
    createdAt: new Date(),
    updatedAt: new Date(),
  })

  for (const key of ['id', 'organizationId', 'userId', 'visibility', 'catalogueStatus', 'createdAt', 'updatedAt']) {
    assert.ok(!(key in snapshot), `${key} must not be snapshotted — it belongs to the author's row, not the entry`)
  }
})

test('a shared skill snapshot carries its instructions', () => {
  const snapshot = buildSnapshot('shared_skill', {
    id: 's1',
    name: 'Qualify',
    description: 'Qualify a lead',
    category: 'Community',
    instructions: 'Ask about budget.',
    tags: ['sales'],
    integrations: [],
    authorName: 'Rin',
    organizationId: 'org-1',
  })

  assert.equal(snapshot.instructions, 'Ask about budget.')
  assert.ok(!('organizationId' in snapshot))
})

test('an unknown kind is rejected rather than silently snapshotted', () => {
  assert.throws(() => buildSnapshot('mystery' as never, {}), /unknown catalogue kind/i)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/catalogue/__tests__/snapshot.test.ts`
Expected: FAIL — `Cannot find module '../submissions'`.

- [ ] **Step 3: Write the submission library**

Create `src/lib/catalogue/submissions.ts`:

```ts
/**
 * Catalogue submissions: an author's request to publish into the shared
 * catalogue, and the frozen snapshot a reviewer decides on.
 *
 * The snapshot is the point of this module. Reviewing a LIVE row would let an
 * author edit an entry after approval and have the change land in every
 * workspace unreviewed; freezing a copy at submit time makes what was reviewed
 * and what gets published the same bytes.
 */
import { prisma } from '@/lib/prisma'
import type { CatalogueSubmission } from '@prisma/client'

export type SubmissionKind = 'flow_template' | 'agent_template' | 'shared_skill'

export const SUBMISSION_KINDS: readonly SubmissionKind[] = ['flow_template', 'agent_template', 'shared_skill']

/**
 * The fields carried into a published entry, per kind. Tenancy and identity
 * columns (id, organizationId, userId, visibility, catalogueStatus, timestamps)
 * are deliberately absent — they belong to the author's row, and the published
 * entry gets its own.
 */
const SNAPSHOT_FIELDS: Record<SubmissionKind, readonly string[]> = {
  flow_template: ['name', 'description', 'category', 'graph', 'trigger', 'notes', 'bindings', 'configuration'],
  agent_template: ['name', 'description', 'type', 'configuration', 'schedule', 'priority', 'metadata'],
  shared_skill: ['name', 'description', 'category', 'instructions', 'tags', 'integrations', 'authorName'],
}

/** Freeze the publishable fields of `row` for review. Pure. */
export function buildSnapshot(kind: SubmissionKind, row: Record<string, unknown>): Record<string, unknown> {
  const fields = SNAPSHOT_FIELDS[kind]
  if (!fields) throw new Error(`Unknown catalogue kind: ${kind}`)
  const snapshot: Record<string, unknown> = {}
  for (const field of fields) {
    if (row[field] !== undefined && row[field] !== null) snapshot[field] = row[field]
  }
  return snapshot
}

export interface CreateSubmissionParams {
  organizationId: string
  userId: string
  kind: SubmissionKind
  sourceId: string
  title: string
  summary: string
}

/**
 * Snapshot the author's row and open a pending submission. Throws when the
 * source row is not the caller's — the read is org-scoped, so another
 * workspace's row simply does not resolve.
 */
export async function createSubmission(params: CreateSubmissionParams): Promise<CatalogueSubmission> {
  const source = await loadSource(params.kind, params.sourceId, params.organizationId)
  if (!source) throw new Error('That item no longer exists in your workspace.')

  return prisma.catalogueSubmission.create({
    data: {
      kind: params.kind,
      title: params.title,
      summary: params.summary,
      snapshot: buildSnapshot(params.kind, source) as never,
      sourceId: params.sourceId,
      organizationId: params.organizationId,
      submittedByUserId: params.userId,
    },
  })
}

async function loadSource(
  kind: SubmissionKind,
  id: string,
  organizationId: string,
): Promise<Record<string, unknown> | null> {
  const where = { id, organizationId, isActive: true }
  if (kind === 'flow_template') return prisma.flowTemplate.findFirst({ where }) as never
  if (kind === 'agent_template') return prisma.agentTemplate.findFirst({ where }) as never
  return prisma.sharedSkill.findFirst({ where }) as never
}
```

- [ ] **Step 4: Run the snapshot test**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/catalogue/__tests__/snapshot.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing route test**

Create `src/app/api/catalogue/__tests__/submissions.db.test.ts`:

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
  let customer: any
  let partner: any
  let partnerTemplateId: string
  let customerTemplateId: string

  const mkTemplate = (organizationId: string, userId: string) =>
    prisma.agentTemplate.create({
      data: { name: 'Digest', type: 'Reporting', configuration: { instructions: 'do a thing' }, organizationId, userId },
    })

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    installTestAuth = testAuth.installTestAuth
    customer = await testAuth.seedTestOrg(prisma, { orgKind: 'customer' })
    partner = await testAuth.seedTestOrg(prisma, { orgKind: 'partner' })
    customerTemplateId = (await mkTemplate(customer.organizationId, customer.userId)).id
    partnerTemplateId = (await mkTemplate(partner.organizationId, partner.userId)).id
  })

  after(async () => {
    if (partner) await partner.cleanup()
    if (customer) await customer.cleanup()
  })

  const post = (body: unknown) =>
    new NextRequest(new URL('http://test/api/catalogue/submissions'), {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    })

  test('a customer workspace cannot submit to the catalogue', async () => {
    installTestAuth(customer.auth)
    const { POST } = await import('../submissions/route')
    const response = await POST(post({
      kind: 'agent_template',
      sourceId: customerTemplateId,
      title: 'Digest',
      summary: 'A weekly digest.',
    }))
    assert.equal(response.status, 403)
    assert.equal((await response.json()).code, 'PERMISSION_DENIED')
  })

  test('a partner workspace submits and gets a pending row with a frozen snapshot', async () => {
    installTestAuth(partner.auth)
    const { POST } = await import('../submissions/route')
    const response = await POST(post({
      kind: 'agent_template',
      sourceId: partnerTemplateId,
      title: 'Digest',
      summary: 'A weekly digest.',
    }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.submission.status, 'pending')

    // Editing the source afterward must not change what a reviewer sees.
    await prisma.agentTemplate.update({
      where: { id: partnerTemplateId, organizationId: partner.organizationId },
      data: { configuration: { instructions: 'something else entirely' } },
    })
    const row = await prisma.catalogueSubmission.findFirst({
      where: { id: body.submission.id, organizationId: partner.organizationId },
    })
    assert.equal((row.snapshot as any).configuration.instructions, 'do a thing')
  })

  test('submitting another workspace item fails without leaking its existence', async () => {
    installTestAuth(partner.auth)
    const { POST } = await import('../submissions/route')
    const response = await POST(post({
      kind: 'agent_template',
      sourceId: customerTemplateId,
      title: 'Not mine',
      summary: 'Should not resolve.',
    }))
    assert.equal(response.status, 404)
  })

  test('an author sees only their own workspace submissions', async () => {
    installTestAuth(partner.auth)
    const { GET } = await import('../submissions/route')
    const response = await GET(new NextRequest(new URL('http://test/api/catalogue/submissions')))
    const body = await response.json()
    assert.ok(body.submissions.length >= 1)
    for (const submission of body.submissions) {
      assert.equal(submission.organizationId, partner.organizationId)
    }
  })

  test('an author withdraws their own pending submission', async () => {
    installTestAuth(partner.auth)
    const pending = await prisma.catalogueSubmission.findFirst({
      where: { organizationId: partner.organizationId, status: 'pending' },
    })
    const { DELETE } = await import('../submissions/[id]/route')
    const response = await DELETE(
      new NextRequest(new URL(`http://test/api/catalogue/submissions/${pending.id}`), { method: 'DELETE' }),
      { params: Promise.resolve({ id: pending.id }) },
    )
    assert.equal(response.status, 200)
    const row = await prisma.catalogueSubmission.findFirst({
      where: { id: pending.id, organizationId: partner.organizationId },
    })
    assert.equal(row.status, 'withdrawn')
  })
}
```

- [ ] **Step 6: Run it to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/catalogue/__tests__/submissions.db.test.ts`
Expected: FAIL — `Cannot find module '../submissions/route'`.

- [ ] **Step 7: Write the routes**

Create `src/app/api/catalogue/submissions/route.ts`:

```ts
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { createSubmission, SUBMISSION_KINDS, type SubmissionKind } from '@/lib/catalogue/submissions'

const submitSchema = z.object({
  kind: z.enum(SUBMISSION_KINDS as unknown as [SubmissionKind, ...SubmissionKind[]]),
  sourceId: z.string().min(1),
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(2000),
})

// The author's own queue: what this workspace has submitted and where it stands.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const submissions = await prisma.catalogueSubmission.findMany({
    where: { organizationId: auth.organizationId },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })
  return { success: true, submissions }
}, { permission: 'template.author' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = submitSchema.parse(await request.json())
  try {
    const submission = await createSubmission({
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      kind: data.kind,
      sourceId: data.sourceId,
      title: data.title,
      summary: data.summary,
    })
    return { success: true, submission }
  } catch {
    // The source read is org-scoped, so another workspace's row simply does not
    // resolve — a 404 rather than a 403, which would confirm it exists.
    throw new ApiError('That item no longer exists in your workspace.', 404, 'NOT_FOUND')
  }
}, { permission: 'template.submit' })
```

Create `src/app/api/catalogue/submissions/[id]/route.ts`:

```ts
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import type { NextRequest } from 'next/server'

type Context = { params: Promise<{ id: string }> }

// Withdraw: an author pulls back a submission a reviewer has not decided yet.
// Decided rows are immutable — the decision is the record.
export const DELETE = withAuthenticatedApi(async (_request: NextRequest, auth, context?: unknown) => {
  const { id } = await (context as Context).params
  const result = await prisma.catalogueSubmission.updateMany({
    where: { id, organizationId: auth.organizationId, status: 'pending' },
    data: { status: 'withdrawn' },
  })
  if (!result.count) throw new ApiError('That submission is not pending.', 404, 'NOT_FOUND')
  return { success: true }
}, { permission: 'template.submit' })
```

The wrapper's handler signature takes `(request, auth)`. Widen `AuthenticatedHandler` in `src/lib/server/api-handler.ts` to pass a third argument through:

```ts
type AuthenticatedHandler = (
  request: NextRequest,
  auth: AuthContext,
  context?: unknown,
) => Promise<Response | Record<string, unknown>>
```

and forward it:

```ts
  return async (request: NextRequest, context?: unknown): Promise<Response> => {
    ...
      const result = await handler(request, auth, context)
```

- [ ] **Step 8: Run the tests**

Run: `TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/catalogue/__tests__/submissions.db.test.ts`
Expected: PASS, 5 tests.

Run: `TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro npm test` — the widened handler signature touches every route, so the full suite is the check here.

Then: `npm run typecheck && npm run lint`.

- [ ] **Step 9: Commit**

```bash
git add src/lib/catalogue src/app/api/catalogue src/lib/server/api-handler.ts
git commit -m "feat(catalogue): authors submit a frozen snapshot for review"
```

---

### Task 8: Review, publish, and takedown

**Files:**
- Create: `src/lib/catalogue/publish.ts`
- Create: `src/app/api/catalogue/review/route.ts`
- Create: `src/app/api/catalogue/review/[id]/route.ts`
- Create: `src/app/api/catalogue/entries/[id]/route.ts`
- Test: `src/app/api/catalogue/__tests__/review.db.test.ts`

**Interfaces:**
- Consumes: `CatalogueSubmission`, `buildSnapshot`, `SubmissionKind` (Task 7); `catalogue.review` / `catalogue.publish` / `catalogue.takedown` (Task 2); `createTemplate`, `createFlowTemplate` (existing single writers).
- Produces:
  - `publishSubmission(params: { submissionId: string; reviewerUserId: string; internalOrgId: string }): Promise<{ publishedEntryId: string }>`
  - `resolveInternalOrgId(): Promise<string>`
  - `GET /api/catalogue/review` (cross-org queue), `POST /api/catalogue/review/[id]` (decide), `DELETE /api/catalogue/entries/[id]` (takedown)

- [ ] **Step 1: Write the failing test**

Create `src/app/api/catalogue/__tests__/review.db.test.ts`:

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
  let partner: any
  let backstory: any
  let submissionId: string

  const openSubmission = async () => {
    const submission = await prisma.catalogueSubmission.create({
      data: {
        kind: 'agent_template',
        title: 'Weekly pipeline digest',
        summary: 'Summarises pipeline movement every Monday.',
        snapshot: {
          name: 'Weekly pipeline digest',
          description: 'A digest',
          type: 'Reporting',
          configuration: { instructions: 'Summarise the pipeline.', authorName: 'Rin' },
        },
        organizationId: partner.organizationId,
        submittedByUserId: partner.userId,
      },
    })
    return submission.id
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    installTestAuth = testAuth.installTestAuth
    partner = await testAuth.seedTestOrg(prisma, { orgKind: 'partner' })
    backstory = await testAuth.seedTestOrg(prisma, { orgKind: 'internal', platformRole: 'reviewer' })
    submissionId = await openSubmission()
  })

  after(async () => {
    if (backstory) await backstory.cleanup()
    if (partner) await partner.cleanup()
  })

  const decide = (id: string, body: unknown) => [
    new NextRequest(new URL(`http://test/api/catalogue/review/${id}`), {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ id }) },
  ] as const

  test('a submitter cannot read the cross-org review queue', async () => {
    installTestAuth(partner.auth)
    const { GET } = await import('../review/route')
    const response = await GET(new NextRequest(new URL('http://test/api/catalogue/review')))
    assert.equal(response.status, 403)
  })

  test('a reviewer sees pending submissions from every workspace', async () => {
    installTestAuth(backstory.auth)
    const { GET } = await import('../review/route')
    const response = await GET(new NextRequest(new URL('http://test/api/catalogue/review')))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.ok(body.submissions.some((s: any) => s.id === submissionId))
  })

  test('requesting changes leaves the submission un-published', async () => {
    installTestAuth(backstory.auth)
    const id = await openSubmission()
    const { POST } = await import('../review/[id]/route')
    const response = await POST(...decide(id, { decision: 'changes_requested', note: 'Add a setup step.' }))
    assert.equal(response.status, 200)
    const row = await prisma.catalogueSubmission.findFirst({ where: { id, organizationId: partner.organizationId } })
    assert.equal(row.status, 'changes_requested')
    assert.equal(row.reviewNote, 'Add a setup step.')
    assert.equal(row.publishedEntryId, null)
  })

  test('approving publishes into the internal org and stamps the entry', async () => {
    installTestAuth(backstory.auth)
    const { POST } = await import('../review/[id]/route')
    const response = await POST(...decide(submissionId, { decision: 'approved' }))
    assert.equal(response.status, 200)

    const row = await prisma.catalogueSubmission.findFirst({
      where: { id: submissionId, organizationId: partner.organizationId },
    })
    assert.equal(row.status, 'approved')
    assert.ok(row.publishedEntryId)

    const entry = await prisma.agentTemplate.findFirst({
      where: { id: row.publishedEntryId, organizationId: backstory.organizationId },
    })
    assert.equal(entry.visibility, 'global')
    assert.equal(entry.catalogueStatus, 'published')
    // The approving reviewer is the accountable owner, not the outside author.
    assert.equal(entry.userId, backstory.userId)
    assert.equal((entry.configuration as any).authorName, 'Rin')
  })

  test('a second approval of the same submission conflicts rather than double-publishing', async () => {
    installTestAuth(backstory.auth)
    const { POST } = await import('../review/[id]/route')
    const response = await POST(...decide(submissionId, { decision: 'approved' }))
    assert.equal(response.status, 409)
    assert.equal((await response.json()).code, 'ALREADY_DECIDED')
  })

  test('approving still works when the author deleted the source row', async () => {
    installTestAuth(backstory.auth)
    const orphan = await prisma.catalogueSubmission.create({
      data: {
        kind: 'agent_template',
        title: 'Orphaned entry',
        summary: 'The author deleted the original after submitting.',
        snapshot: { name: 'Orphaned entry', type: 'Reporting', configuration: { instructions: 'Still valid.' } },
        sourceId: 'a-row-that-no-longer-exists',
        organizationId: partner.organizationId,
        submittedByUserId: partner.userId,
      },
    })
    const { POST } = await import('../review/[id]/route')
    const response = await POST(...decide(orphan.id, { decision: 'approved' }))
    // The snapshot is authoritative — publishing never reads the source again,
    // so a deleted original is expected rather than an error.
    assert.equal(response.status, 200)
    assert.ok((await response.json()).publishedEntryId)
  })

  test('takedown retires a published entry without deleting it', async () => {
    installTestAuth(backstory.auth)
    const row = await prisma.catalogueSubmission.findFirst({
      where: { id: submissionId, organizationId: partner.organizationId },
    })
    const { DELETE } = await import('../entries/[id]/route')
    const response = await DELETE(
      new NextRequest(new URL(`http://test/api/catalogue/entries/${row.publishedEntryId}`), { method: 'DELETE' }),
      { params: Promise.resolve({ id: row.publishedEntryId }) },
    )
    assert.equal(response.status, 200)
    const entry = await prisma.agentTemplate.findFirst({
      where: { id: row.publishedEntryId, organizationId: backstory.organizationId },
    })
    assert.equal(entry.isActive, false)
  })
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/catalogue/__tests__/review.db.test.ts`
Expected: FAIL — `Cannot find module '../review/route'`.

- [ ] **Step 3: Write the publish library**

Create `src/lib/catalogue/publish.ts`:

```ts
/**
 * Publishing an approved submission.
 *
 * The published entry is an ORDINARY template row owned by the Backstory
 * internal org, with visibility 'global'. No separate catalogue table exists:
 * every read path (fetchCatalogueRows, fetchFlowTemplateRows, the skills
 * library) already understands 'global', so publishing needs no new reader and
 * staff can edit a published entry like any other row.
 */
import { prisma, systemPrisma } from '@/lib/prisma'
import { createTemplate } from '@/lib/templates/create-template'
import { createFlowTemplate } from '@/lib/flows/templates/create'
import type { SubmissionKind } from './submissions'

/**
 * The org that owns published catalogue entries. Misconfiguration here is loud
 * on purpose — a silent fallback would publish into someone's workspace.
 */
export async function resolveInternalOrgId(): Promise<string> {
  // systemPrisma: resolving the platform's own tenant is org-less by nature.
  const org = await systemPrisma.organization.findFirst({
    where: { kind: 'internal' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  if (!org) {
    throw new Error(
      'No internal organization exists to own catalogue entries. Set PLATFORM_STAFF_EMAILS and sign in as a listed address to mark one.',
    )
  }
  return org.id
}

export interface PublishParams {
  submissionId: string
  reviewerUserId: string
  internalOrgId: string
}

/** Write an approved snapshot into the catalogue. Returns the new entry's id. */
export async function publishSubmission(params: PublishParams): Promise<{ publishedEntryId: string }> {
  // systemPrisma: the reviewer's org is the INTERNAL org, not the submitting
  // one, so this read crosses tenants by design — it is the review queue.
  const submission = await systemPrisma.catalogueSubmission.findUnique({
    where: { id: params.submissionId },
  })
  if (!submission) throw new Error('That submission no longer exists.')

  const snapshot = submission.snapshot as Record<string, unknown>
  const kind = submission.kind as SubmissionKind

  if (kind === 'agent_template') {
    const entry = await createTemplate({
      organizationId: params.internalOrgId,
      // The APPROVING REVIEWER owns the entry: they are accountable for what
      // the catalogue serves. Author attribution rides in configuration.authorName.
      userId: params.reviewerUserId,
      name: String(snapshot.name ?? submission.title),
      description: typeof snapshot.description === 'string' ? snapshot.description : '',
      category: String(snapshot.type ?? 'Custom'),
      configuration: (snapshot.configuration ?? {}) as Record<string, unknown>,
      visibility: 'global',
    })
    await prisma.agentTemplate.update({
      where: { id: entry.id, organizationId: params.internalOrgId },
      data: { catalogueStatus: 'published' },
    })
    return { publishedEntryId: entry.id }
  }

  if (kind === 'flow_template') {
    const configuration = (snapshot.configuration ?? {}) as Record<string, unknown>
    const entry = await createFlowTemplate({
      organizationId: params.internalOrgId,
      userId: params.reviewerUserId,
      name: String(snapshot.name ?? submission.title),
      description: typeof snapshot.description === 'string' ? snapshot.description : '',
      category: String(snapshot.category ?? 'Custom'),
      graph: snapshot.graph as never,
      notes: snapshot.notes as never,
      bindings: (snapshot.bindings ?? []) as never,
      integrations: (configuration.integrations ?? []) as string[],
      tags: (configuration.tags ?? []) as string[],
      icon: typeof configuration.icon === 'string' ? configuration.icon : undefined,
      exampleOutput: typeof configuration.exampleOutput === 'string' ? configuration.exampleOutput : undefined,
      authorName: typeof configuration.authorName === 'string' ? configuration.authorName : '',
      visibility: 'global',
    })
    await prisma.flowTemplate.update({
      where: { id: entry.id, organizationId: params.internalOrgId },
      data: { catalogueStatus: 'published' },
    })
    return { publishedEntryId: entry.id }
  }

  const entry = await prisma.sharedSkill.create({
    data: {
      name: String(snapshot.name ?? submission.title),
      description: typeof snapshot.description === 'string' ? snapshot.description : '',
      category: String(snapshot.category ?? 'Community'),
      instructions: String(snapshot.instructions ?? ''),
      tags: (snapshot.tags ?? []) as never,
      integrations: (snapshot.integrations ?? []) as never,
      authorName: typeof snapshot.authorName === 'string' ? snapshot.authorName : '',
      organizationId: params.internalOrgId,
      userId: params.reviewerUserId,
      visibility: 'global',
      catalogueStatus: 'published',
    },
  })
  return { publishedEntryId: entry.id }
}
```

- [ ] **Step 4: Write the review routes**

Create `src/app/api/catalogue/review/route.ts`:

```ts
import { systemPrisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

// The reviewer queue. systemPrisma: this read crosses tenants BY DESIGN — the
// queue's whole purpose is seeing other workspaces' submissions. The
// catalogue.review permission is what makes it safe, and only an internal-org
// reviewer holds it.
export const GET = withAuthenticatedApi(async (request) => {
  const status = request.nextUrl.searchParams.get('status') ?? 'pending'
  const submissions = await systemPrisma.catalogueSubmission.findMany({
    where: { status },
    orderBy: { createdAt: 'asc' },
    take: 200,
  })
  return { success: true, submissions }
}, { permission: 'catalogue.review' })
```

Create `src/app/api/catalogue/review/[id]/route.ts`:

```ts
import { z } from 'zod'
import { systemPrisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { publishSubmission, resolveInternalOrgId } from '@/lib/catalogue/publish'
import { recordAudit } from '@/lib/audit'
import { notify } from '@/lib/notifications'
import type { NextRequest } from 'next/server'

type Context = { params: Promise<{ id: string }> }

const decisionSchema = z
  .object({
    decision: z.enum(['approved', 'changes_requested', 'rejected']),
    note: z.string().max(2000).optional(),
  })
  .refine((value) => value.decision === 'approved' || Boolean(value.note?.trim()), {
    message: 'Explain what needs to change so the author can act on it.',
    path: ['note'],
  })

export const POST = withAuthenticatedApi(async (request: NextRequest, auth, context?: unknown) => {
  const { id } = await (context as Context).params
  const data = decisionSchema.parse(await request.json())

  // Conditional on status='pending': two reviewers deciding at once cannot both
  // win, so an entry is never double-published.
  const claimed = await systemPrisma.catalogueSubmission.updateMany({
    where: { id, status: 'pending' },
    data: {
      status: data.decision,
      reviewNote: data.note ?? null,
      reviewerUserId: auth.dbUser.id,
      decidedAt: new Date(),
    },
  })
  if (!claimed.count) throw new ApiError('That submission has already been decided.', 409, 'ALREADY_DECIDED')

  const submission = await systemPrisma.catalogueSubmission.findUnique({ where: { id } })
  let publishedEntryId: string | null = null

  if (data.decision === 'approved') {
    const internalOrgId = await resolveInternalOrgId()
    try {
      ;({ publishedEntryId } = await publishSubmission({
        submissionId: id,
        reviewerUserId: auth.dbUser.id,
        internalOrgId,
      }))
      await systemPrisma.catalogueSubmission.update({ where: { id }, data: { publishedEntryId } })
    } catch (error) {
      // Publishing failed after the claim: return the row to pending so the
      // decision can be retried rather than stranding it as approved-but-unpublished.
      await systemPrisma.catalogueSubmission.update({
        where: { id },
        data: { status: 'pending', decidedAt: null, reviewerUserId: null },
      })
      throw new ApiError('Publishing failed; the submission is still pending.', 500, 'PUBLISH_FAILED', error)
    }
  }

  await recordAudit({
    organizationId: auth.organizationId,
    action: `catalogue.${data.decision}`,
    actorUserId: auth.dbUser.id,
    resourceType: submission?.kind ?? null,
    resourceId: publishedEntryId ?? id,
    detail: { submissionId: id, submittingOrgId: submission?.organizationId ?? null },
  })

  if (submission) {
    await notify({
      organizationId: submission.organizationId,
      userId: submission.submittedByUserId,
      type: 'catalogue.decision',
      level: 'info',
      title:
        data.decision === 'approved'
          ? `"${submission.title}" is published to the catalogue`
          : `"${submission.title}" needs changes`,
      body: data.note ?? 'Your submission was approved and is now in the shared catalogue.',
      link: '/templates',
    })
  }

  return { success: true, status: data.decision, publishedEntryId }
}, { permission: 'catalogue.publish' })
```

Create `src/app/api/catalogue/entries/[id]/route.ts`:

```ts
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { resolveInternalOrgId } from '@/lib/catalogue/publish'
import { recordAudit } from '@/lib/audit'
import type { NextRequest } from 'next/server'

type Context = { params: Promise<{ id: string }> }

// Takedown: retire a published entry. isActive=false is what every catalogue
// read already filters on, so the entry stops being served without the row (and
// its audit trail) being destroyed.
export const DELETE = withAuthenticatedApi(async (_request: NextRequest, auth, context?: unknown) => {
  const { id } = await (context as Context).params
  const internalOrgId = await resolveInternalOrgId()

  const retired =
    (await prisma.agentTemplate.updateMany({ where: { id, organizationId: internalOrgId }, data: { isActive: false } })).count ||
    (await prisma.flowTemplate.updateMany({ where: { id, organizationId: internalOrgId }, data: { isActive: false } })).count ||
    (await prisma.sharedSkill.updateMany({ where: { id, organizationId: internalOrgId }, data: { isActive: false } })).count

  if (!retired) throw new ApiError('That catalogue entry does not exist.', 404, 'NOT_FOUND')

  await recordAudit({
    organizationId: auth.organizationId,
    action: 'catalogue.takedown',
    actorUserId: auth.dbUser.id,
    resourceId: id,
  })
  return { success: true }
}, { permission: 'catalogue.takedown' })
```

- [ ] **Step 5: Confirm the notify signature**

Run: `grep -n "export async function notify" -A 20 src/lib/notifications/*.ts`
Match the call above to the real parameter names. If `link` or `level` differ, adjust the call rather than the library.

- [ ] **Step 6: Run the tests**

Run: `TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/catalogue/__tests__/review.db.test.ts`
Expected: PASS, 7 tests.

Then: `TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro npm test`, `npm run typecheck && npm run lint`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/catalogue/publish.ts src/app/api/catalogue
git commit -m "feat(catalogue): reviewers publish approved submissions and retire entries"
```

---

### Task 9: The staff review surface

**Files:**
- Create: `src/app/admin/layout.tsx`
- Create: `src/app/admin/catalogue/page.tsx`
- Create: `src/components/admin/submission-queue.tsx`
- Create: `src/components/admin/submission-detail.tsx`
- Modify: `src/lib/supabase/middleware.ts:86`
- Test: `src/components/admin/__tests__/submission-queue.test.tsx`

**Interfaces:**
- Consumes: `GET /api/catalogue/review`, `POST /api/catalogue/review/[id]`, `DELETE /api/catalogue/entries/[id]` (Task 8); `useAuth()` permissions (Task 3).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Expose permissions to the client**

Check what `/api/auth/context` returns and add the permission list:

Run: `grep -rn "permissions\|role" src/app/api/auth/context/route.ts src/hooks/use-auth.ts`

In `src/app/api/auth/context/route.ts`, add `permissions: [...auth.permissions]` to the response body. In `src/hooks/use-auth.ts`, expose `permissions: string[]` and a `can = (permission: string) => permissions.includes(permission)` helper alongside the existing role fields.

- [ ] **Step 2: Write the failing component test**

Create `src/components/admin/__tests__/submission-queue.test.tsx`:

```tsx
import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen } from '@testing-library/react'
import { SubmissionQueue } from '../submission-queue'

const submissions = [
  {
    id: 's1',
    kind: 'flow_template',
    title: 'Weekly pipeline digest',
    summary: 'Summarises pipeline movement every Monday.',
    status: 'pending',
    organizationId: 'org-1',
    createdAt: new Date('2026-07-20T10:00:00Z').toISOString(),
  },
]

test('the queue lists a pending submission with a plain-English kind', () => {
  render(<SubmissionQueue submissions={submissions} selectedId={null} onSelect={() => {}} />)
  assert.ok(screen.getByText('Weekly pipeline digest'))
  // Plain English, never the raw enum and never token syntax.
  assert.ok(screen.getByText('Flow template'))
  assert.equal(screen.queryByText(/flow_template/), null)
})

test('an empty queue says so rather than rendering a bare list', () => {
  render(<SubmissionQueue submissions={[]} selectedId={null} onSelect={() => {}} />)
  assert.ok(screen.getByText(/nothing waiting for review/i))
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/admin/__tests__/submission-queue.test.tsx`
Expected: FAIL — `Cannot find module '../submission-queue'`.

- [ ] **Step 4: Build the queue component**

Create `src/components/admin/submission-queue.tsx`:

```tsx
'use client'

export interface QueuedSubmission {
  id: string
  kind: string
  title: string
  summary: string
  status: string
  organizationId: string
  createdAt: string
}

// Plain English everywhere a raw enum would otherwise leak into the UI.
const KIND_LABELS: Record<string, string> = {
  flow_template: 'Flow template',
  agent_template: 'Agent template',
  shared_skill: 'Skill',
}

export function SubmissionQueue({
  submissions,
  selectedId,
  onSelect,
}: {
  submissions: QueuedSubmission[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  if (submissions.length === 0) {
    return (
      <p className="p-6 text-sm text-neutral-500">
        Nothing waiting for review right now.
      </p>
    )
  }

  return (
    <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
      {submissions.map((submission) => (
        <li key={submission.id}>
          <button
            type="button"
            onClick={() => onSelect(submission.id)}
            aria-current={selectedId === submission.id}
            className="w-full px-4 py-3 text-left hover:bg-neutral-50 aria-[current=true]:bg-neutral-100 dark:hover:bg-neutral-900 dark:aria-[current=true]:bg-neutral-900"
          >
            <span className="block text-sm font-medium">{submission.title}</span>
            <span className="mt-0.5 block text-xs text-neutral-500">
              {KIND_LABELS[submission.kind] ?? submission.kind}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
```

- [ ] **Step 5: Run the component test**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/admin/__tests__/submission-queue.test.tsx`
Expected: PASS, 2 tests.

- [ ] **Step 6: Build the detail pane and the page**

Create `src/components/admin/submission-detail.tsx`:

```tsx
'use client'

import { useState } from 'react'
import type { QueuedSubmission } from './submission-queue'

type Decision = 'approved' | 'changes_requested' | 'rejected'

// Approve needs no note; the other two are worthless to an author without one.
const NOTE_REQUIRED: Record<Decision, boolean> = {
  approved: false,
  changes_requested: true,
  rejected: true,
}

export function SubmissionDetail({
  submission,
  onDecided,
}: {
  submission: QueuedSubmission & { snapshot: Record<string, unknown> }
  onDecided: () => void
}) {
  const [pending, setPending] = useState<Decision | null>(null)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function decide(decision: Decision) {
    if (NOTE_REQUIRED[decision] && !note.trim()) {
      setError('Explain what needs to change so the author can act on it.')
      return
    }
    setBusy(true)
    setError(null)
    const response = await fetch(`/api/catalogue/review/${submission.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision, note: note.trim() || undefined }),
    })
    setBusy(false)
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      // 409 means another reviewer got there first — say so plainly.
      setError(
        response.status === 409
          ? 'Another reviewer already decided this one.'
          : body.error ?? 'That decision could not be saved. Try again.',
      )
      return
    }
    setNote('')
    setPending(null)
    onDecided()
  }

  const instructions =
    typeof submission.snapshot.instructions === 'string'
      ? submission.snapshot.instructions
      : typeof (submission.snapshot.configuration as { instructions?: unknown } | undefined)?.instructions === 'string'
        ? String((submission.snapshot.configuration as { instructions: string }).instructions)
        : null

  return (
    <div className="space-y-4 p-6">
      <header>
        <h2 className="text-lg font-medium">{submission.title}</h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">{submission.summary}</p>
      </header>

      {instructions && (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-neutral-50 p-4 text-xs dark:bg-neutral-900">
          {instructions}
        </pre>
      )}

      {pending && NOTE_REQUIRED[pending] && (
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="What does the author need to change?"
          className="w-full rounded-md border px-3 py-2 text-sm"
          rows={3}
        />
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex gap-3">
        <button type="button" disabled={busy} onClick={() => decide('approved')} className="text-sm font-medium underline">
          Approve &amp; publish
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => (pending === 'changes_requested' ? decide('changes_requested') : setPending('changes_requested'))}
          className="text-sm underline"
        >
          Request changes
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => (pending === 'rejected' ? decide('rejected') : setPending('rejected'))}
          className="text-sm text-neutral-500 underline"
        >
          Reject
        </button>
      </div>
    </div>
  )
}
```

For `flow_template` submissions, render the graph above the instructions block using the existing flow-template preview component. Locate it first:

Run: `grep -rn "export function.*Preview\|export default function.*Preview" src/components/flows/templates/`

Pass it `submission.snapshot.graph` and `submission.snapshot.notes`. If no reusable preview exists, fall back to the same `<pre>` treatment over `JSON.stringify(snapshot.graph, null, 2)` and note the gap in the commit message — a graph diff is a nice-to-have, not what gates this task.

Create `src/app/admin/layout.tsx`:

```tsx
import { redirect } from 'next/navigation'
import { requireAuthContext } from '@/lib/server/auth'

// The admin surface is invisible to customer workspaces: no nav entry, and a
// direct URL redirects rather than rendering a shell they cannot use.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireAuthContext().catch(() => null)
  if (!auth?.can('catalogue.review')) redirect('/dashboard')
  return <div className="mx-auto max-w-6xl px-6 py-8">{children}</div>
}
```

Create `src/app/admin/catalogue/page.tsx` — a client page with four tabs (Queue, Published, Legacy, Members), the queue on the left and the detail pane on the right. Fetch `/api/catalogue/review?status=pending` for Queue. Published and Legacy list entries by `catalogueStatus`; add a `GET /api/catalogue/entries?status=published|legacy_published` route gated on `catalogue.review` following the shape of `src/app/api/catalogue/review/route.ts`. Members lists users in internal/partner orgs with controls to set `platformRole` and `Organization.kind`, backed by a `PATCH /api/catalogue/staff` route gated on `catalogue.review`.

- [ ] **Step 7: Keep the middleware from redirecting /admin**

In `src/lib/supabase/middleware.ts`, confirm `/admin` is treated as an authenticated page (it is not in `publicPages`, so it already is). Add nothing unless the check at line 86 excludes it — verify by reading the surrounding block first.

- [ ] **Step 8: Verify in the running app**

Use the `run` skill to launch the app with `DEV_BYPASS_AUTH` and dummy Supabase vars, seed a reviewer, and confirm: `/admin/catalogue` renders for a reviewer, redirects to `/dashboard` for a customer admin, and an approve round-trips into the catalogue.

Then: `npm run typecheck && npm run lint`.

- [ ] **Step 9: Commit**

```bash
git add src/app/admin src/components/admin src/app/api/auth/context/route.ts src/hooks/use-auth.ts
git commit -m "feat(catalogue): a staff surface for reviewing and publishing submissions"
```

---

### Task 10: Author-side submit and status

**Files:**
- Create: `src/components/templates/submit-to-catalogue.tsx`
- Modify: the flow-template, agent-template, and skill card components (locate with `grep -rln "Publish\|visibility" src/components/templates src/components/flows/templates src/components/skills`)
- Test: `src/components/templates/__tests__/submit-to-catalogue.test.tsx`

**Interfaces:**
- Consumes: `POST /api/catalogue/submissions`, `GET /api/catalogue/submissions` (Task 7); `useAuth().can` (Task 9).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Create `src/components/templates/__tests__/submit-to-catalogue.test.tsx`:

```tsx
import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen } from '@testing-library/react'
import { SubmitToCatalogue } from '../submit-to-catalogue'

const item = { id: 't1', kind: 'agent_template' as const, name: 'Weekly digest' }

test('a workspace without submit rights sees no catalogue affordance', () => {
  render(<SubmitToCatalogue item={item} canSubmit={false} submission={null} />)
  assert.equal(screen.queryByRole('button', { name: /submit to catalogue/i }), null)
})

test('a workspace with submit rights can open the submit form', () => {
  render(<SubmitToCatalogue item={item} canSubmit submission={null} />)
  assert.ok(screen.getByRole('button', { name: /submit to catalogue/i }))
})

test('a pending submission shows its status instead of the submit button', () => {
  render(<SubmitToCatalogue item={item} canSubmit submission={{ id: 's1', status: 'pending', reviewNote: null }} />)
  assert.ok(screen.getByText(/waiting for review/i))
  assert.equal(screen.queryByRole('button', { name: /submit to catalogue/i }), null)
})

test('a changes-requested submission shows the reviewer note and lets the author resubmit', () => {
  render(
    <SubmitToCatalogue
      item={item}
      canSubmit
      submission={{ id: 's1', status: 'changes_requested', reviewNote: 'Add a setup step.' }}
    />,
  )
  assert.ok(screen.getByText('Add a setup step.'))
  assert.ok(screen.getByRole('button', { name: /submit to catalogue/i }))
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/templates/__tests__/submit-to-catalogue.test.tsx`
Expected: FAIL — `Cannot find module '../submit-to-catalogue'`.

- [ ] **Step 3: Build the component**

Create `src/components/templates/submit-to-catalogue.tsx`:

```tsx
'use client'

import { useState } from 'react'

export interface SubmissionStatus {
  id: string
  status: string
  reviewNote: string | null
}

export interface CatalogueItem {
  id: string
  kind: 'flow_template' | 'agent_template' | 'shared_skill'
  name: string
}

// Status copy is plain English: the author should never see a raw enum.
const STATUS_COPY: Record<string, string> = {
  pending: 'Waiting for review',
  approved: 'Published to the catalogue',
  rejected: 'Not accepted for the catalogue',
}

export function SubmitToCatalogue({
  item,
  canSubmit,
  submission,
}: {
  item: CatalogueItem
  canSubmit: boolean
  submission: SubmissionStatus | null
}) {
  const [open, setOpen] = useState(false)
  const [summary, setSummary] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Only Backstory and People.ai workspaces may propose catalogue entries.
  // Everyone else shares within their own workspace, and sees nothing here.
  if (!canSubmit) return null

  // A decided-but-resubmittable state (changes_requested) falls through to the
  // form so the author can act on the note without hunting for a second button.
  const settled = submission && submission.status !== 'changes_requested'
  if (settled) {
    return (
      <p className="text-xs text-neutral-500">
        {STATUS_COPY[submission.status] ?? 'Submitted'}
      </p>
    )
  }

  async function submit() {
    if (!summary.trim()) {
      setError('Describe what this does, so a reviewer knows what they are approving.')
      return
    }
    setBusy(true)
    setError(null)
    const response = await fetch('/api/catalogue/submissions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: item.kind, sourceId: item.id, title: item.name, summary }),
    })
    setBusy(false)
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      setError(body.error ?? 'That could not be submitted. Try again.')
      return
    }
    setOpen(false)
    setSummary('')
  }

  return (
    <div className="space-y-2">
      {submission?.status === 'changes_requested' && submission.reviewNote && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {submission.reviewNote}
        </p>
      )}

      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="text-xs font-medium underline">
          Submit to catalogue
        </button>
      ) : (
        <div className="space-y-2">
          <textarea
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            placeholder="What does this do, and who is it for?"
            className="w-full rounded-md border px-3 py-2 text-sm"
            rows={3}
          />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={submit} disabled={busy} className="text-xs font-medium underline">
              {busy ? 'Submitting…' : 'Send for review'}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="text-xs text-neutral-500">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/templates/__tests__/submit-to-catalogue.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Wire it into the existing cards**

Locate the components that currently render a publish or visibility control:

Run: `grep -rln "Publish\|visibility" src/components/templates src/components/flows/templates src/components/skills`

In each, replace the old publish control with `<SubmitToCatalogue />`, passing `canSubmit={can('template.submit')}` from `useAuth()` and the matching submission from a `GET /api/catalogue/submissions` fetch keyed by `sourceId`.

- [ ] **Step 6: Verify in the running app**

Use the `run` skill: as a partner workspace, submit a template and confirm it appears in `/admin/catalogue`; as a customer workspace, confirm no submit affordance renders anywhere.

Run the full suite: `TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro npm test`
Then: `npm run typecheck && npm run lint`.

- [ ] **Step 7: Commit**

```bash
git add src/components
git commit -m "feat(catalogue): authors send work for review and see where it stands"
```

---

## Verification

After Task 10, confirm end to end:

1. `TEST_DATABASE_URL=postgresql://localhost:5432/ci_repro npm test` — full suite green.
2. `npm run typecheck && npm run lint` — clean.
3. A customer workspace: no submit affordance, `POST /api/catalogue/submissions` returns 403 `PERMISSION_DENIED`, `/admin/catalogue` redirects to `/dashboard`, and a template created with `visibility: 'global'` in the body lands org-scoped.
4. A partner workspace: submits, sees "Waiting for review", cannot reach the review queue.
5. A Backstory reviewer: sees the submission, requests changes (the author sees the note), then approves — the entry appears in every workspace's catalogue and takedown removes it.
6. The catalogue is not empty on deploy: rows that were `visibility='global'` before the migration still render, tagged `legacy_published` in the Legacy tab.
