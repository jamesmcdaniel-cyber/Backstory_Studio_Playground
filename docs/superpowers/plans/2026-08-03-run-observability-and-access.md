# Run Observability & Platform Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add runtime-editable platform domain access, correct per-call LLM cost accounting, per-fork run state overrides, and an automated nightly quality gate — without adopting LangGraph or LangSmith.

**Architecture:** Five independent workstreams over the existing Next.js/Prisma/BullMQ stack. Each writes to its own new module and touches existing chokepoints surgically: the auth callback (`isAllowedEmail`), the model runner (four-bucket usage), the flow interpreter (override precedence), and CI (nightly workflow). No new runtime dependencies.

**Tech Stack:** TypeScript, Next.js 15 App Router, Prisma 6 + Postgres, `node:test` + `tsx`, zod, GitHub Actions.

**Source spec:** `docs/superpowers/specs/2026-08-03-run-observability-and-access-design.md`

## Global Constraints

- **No new npm dependencies.** Every workstream uses what is already in `package.json`.
- **Tests:** `node:test` + `node:assert/strict`. Pure tests are `<name>.test.ts`; DB-backed tests are `<name>.db.test.ts` and MUST be wrapped in `if (process.env.TEST_DATABASE_URL) { ... }` so they self-skip locally and run in CI.
- **DB test bootstrap:** set `process.env.DATABASE_URL` and `process.env.DIRECT_URL` from `TEST_DATABASE_URL` **before** any `await import('@/lib/prisma')`. Import Prisma dynamically inside `before()`, never at module top level.
- **Local gate before every commit:** `npm run typecheck && npm run lint && npm test`. Do NOT run `npm run build` locally — it 500s by design without Supabase env vars; Vercel validates builds.
- **Cross-org reads/writes use `systemPrisma`**, never `prisma`. Org-scoped work uses `prisma` (RLS applies).
- **Admin API routes** use `withAuthenticatedApi(handler, { permission: 'catalogue.review' })` from `@/lib/server/api-handler`.
- **No raw token syntax in UI.** Never render `{{ }}` bracket syntax in any user-facing surface. Plain English labels only.
- **Every consequential mutation calls `recordAudit`** from `@/lib/audit`.
- **Migrations** are created with `npx prisma migrate dev --name <name>`, which generates the timestamped directory. Never hand-write migration SQL.
- **Commit directly to `main`.** No feature branches.

---

## File Structure

**Workstream A — Platform domain allowlist**
- Modify `prisma/schema.prisma` — add `PlatformAllowedDomain` model
- Modify `src/lib/auth/company-domain.ts` — add `isPublicEmailProvider`, `normalizeDomain`
- Create `src/lib/auth/allowed-domain.ts` — DB-backed `isAllowedEmail`, `allowedDomainOrg`
- Create `src/lib/auth/__tests__/allowed-domain.test.ts` — pure validation tests
- Create `src/lib/auth/__tests__/allowed-domain.db.test.ts` — gate + provisioning tests
- Modify `src/app/auth/callback/route.ts` — swap `isCompanyEmail` → `isAllowedEmail`
- Modify `src/lib/supabase/auth-utils.ts` — allowlist branch in `provisionUser`
- Create `src/app/api/admin/domains/route.ts` — GET/POST/PATCH
- Create `src/app/admin/domains/page.tsx` — admin UI

**Workstream B — Four-bucket usage**
- Modify `src/lib/llm/model-runner.ts` — `ModelTurn.usage` shape, `billableTokens`
- Modify `src/lib/eval/scripted-runner.ts`, `src/lib/eval/harness.ts` — new fields
- Modify `src/features/agents/execute-agent.ts`, `src/features/flows/execute-flow.ts` — use `billableTokens`
- Create `src/lib/llm/__tests__/usage.test.ts`

**Workstream C — Cost ledger**
- Modify `prisma/schema.prisma` — `LlmCall` model + `costUsd` on `AgentExecution`/`FlowRun`
- Create `src/lib/usage/pricing.ts` — price table + `computeCostUsd`
- Create `src/lib/usage/ledger.ts` — `recordLlmCall`
- Create `src/lib/usage/__tests__/pricing.test.ts`
- Create `src/lib/usage/__tests__/ledger.db.test.ts`
- Modify `src/lib/llm/model-runner.ts`, `src/lib/rag/embeddings.ts` — capture calls
- Create `src/app/api/admin/costs/route.ts`, `src/app/admin/costs/page.tsx`

**Workstream D — Fork state overrides**
- Modify `prisma/schema.prisma` — `FlowRun.stateOverrides`
- Create `src/lib/flows/state-overrides.ts` — key resolution + precedence
- Create `src/lib/flows/__tests__/state-overrides.test.ts`
- Modify `src/features/flows/execute-flow.ts` — apply overrides, patch-resume
- Modify `src/app/api/flows/[id]/execute/route.ts` — accept overrides
- Create `src/features/flows/__tests__/state-overrides.db.test.ts`
- Modify `src/components/flows/run-panel.tsx` — "Fork with edits…"

**Workstream E — Nightly eval gate**
- Create `src/lib/eval/baseline.ts` — comparison logic
- Create `src/lib/eval/__tests__/baseline.test.ts`
- Create `src/lib/eval/baseline.json`
- Create `src/lib/eval/nightly.ts` — runner
- Create `src/lib/eval/capture.ts` — transcript → fixture
- Create `.github/workflows/eval-nightly.yml`
- Modify `package.json` — `eval:nightly`, `eval:capture` scripts

---

# WORKSTREAM A — Platform Domain Allowlist

Ships first: independent of everything else, and the only item currently blocking customers from reaching the platform.

---

### Task 1: Domain validation primitives

Pure functions with no DB. Establishes the safety rules before anything can write to the table.

**Files:**
- Modify: `src/lib/auth/company-domain.ts`
- Test: `src/lib/auth/__tests__/allowed-domain.test.ts` (create)

**Interfaces:**
- Consumes: nothing
- Produces: `normalizeDomain(input: string | null | undefined): string | null`, `isPublicEmailProvider(domain: string): boolean`, `PUBLIC_EMAIL_PROVIDERS: readonly string[]`, existing `COMPANY_EMAIL_DOMAINS` unchanged

- [ ] **Step 1: Write the failing test**

Create `src/lib/auth/__tests__/allowed-domain.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDomain, isPublicEmailProvider } from '@/lib/auth/company-domain'

test('normalizeDomain lowercases and trims a bare domain', () => {
  assert.equal(normalizeDomain('  Customer.COM '), 'customer.com')
  assert.equal(normalizeDomain('customer.com'), 'customer.com')
})

test('normalizeDomain strips a leading @ so pasted addresses work', () => {
  assert.equal(normalizeDomain('@customer.com'), 'customer.com')
})

test('normalizeDomain rejects wildcards, paths, and malformed input', () => {
  assert.equal(normalizeDomain('*.customer.com'), null)
  assert.equal(normalizeDomain('customer.com/path'), null)
  assert.equal(normalizeDomain('customer'), null)
  assert.equal(normalizeDomain('cust omer.com'), null)
  assert.equal(normalizeDomain(''), null)
  assert.equal(normalizeDomain(null), null)
})

test('normalizeDomain rejects a full email address', () => {
  assert.equal(normalizeDomain('person@customer.com'), null)
})

test('isPublicEmailProvider blocks free providers that would open the platform', () => {
  assert.equal(isPublicEmailProvider('gmail.com'), true)
  assert.equal(isPublicEmailProvider('GMAIL.COM'), true)
  assert.equal(isPublicEmailProvider('outlook.com'), true)
  assert.equal(isPublicEmailProvider('yahoo.com'), true)
  assert.equal(isPublicEmailProvider('hotmail.com'), true)
  assert.equal(isPublicEmailProvider('icloud.com'), true)
  assert.equal(isPublicEmailProvider('proton.me'), true)
})

test('isPublicEmailProvider allows a real corporate domain', () => {
  assert.equal(isPublicEmailProvider('customer.com'), false)
  assert.equal(isPublicEmailProvider('people.ai'), false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/auth/__tests__/allowed-domain.test.ts`
Expected: FAIL — `normalizeDomain is not a function` / import error.

- [ ] **Step 3: Write minimal implementation**

Append to `src/lib/auth/company-domain.ts` (leave the existing `COMPANY_EMAIL_DOMAINS` and `isCompanyEmail` exactly as they are):

```ts
/**
 * Free/consumer email providers. Allowing one of these would grant platform
 * access to anyone with an email address, so they are refused outright — this
 * is the highest-consequence mistake an operator can make on this screen.
 */
export const PUBLIC_EMAIL_PROVIDERS = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.net',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'tutanota.com',
  'fastmail.com',
] as const

export function isPublicEmailProvider(domain: string): boolean {
  return (PUBLIC_EMAIL_PROVIDERS as readonly string[]).includes(domain.trim().toLowerCase())
}

// A bare hostname: dot-separated labels, no wildcard, no path, no whitespace,
// at least one dot. Deliberately strict — this string becomes an authorization
// boundary, and the exact-match comparison downstream only holds if the stored
// value is a plain hostname.
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

/**
 * Normalize operator input to a storable domain, or null when it is not a
 * plain hostname. Accepts a leading '@' so pasting "@customer.com" works;
 * rejects a full email address, since storing one would silently allow only
 * that address while reading as a domain rule.
 */
export function normalizeDomain(input: string | null | undefined): string | null {
  const trimmed = input?.trim().toLowerCase()
  if (!trimmed) return null
  const withoutAt = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed
  if (withoutAt.includes('@')) return null
  return DOMAIN_PATTERN.test(withoutAt) ? withoutAt : null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/auth/__tests__/allowed-domain.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/company-domain.ts src/lib/auth/__tests__/allowed-domain.test.ts
git commit -m "feat(auth): domain normalization and public-provider blocklist"
```

---

### Task 2: PlatformAllowedDomain schema and gate

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `src/lib/auth/allowed-domain.ts`
- Test: `src/lib/auth/__tests__/allowed-domain.db.test.ts`

**Interfaces:**
- Consumes: `normalizeDomain`, `isPublicEmailProvider` (Task 1); `emailDomain` from `@/lib/auth/enterprise-policy`; `COMPANY_EMAIL_DOMAINS`, `isCompanyEmail` from `@/lib/auth/company-domain`
- Produces: `isAllowedEmail(email: string | null | undefined): Promise<boolean>`, `allowedDomainOrg(email: string | null | undefined): Promise<string | null>`

- [ ] **Step 1: Add the Prisma model**

In `prisma/schema.prisma`, add after the `OrganizationDomain` model:

```prisma
/// Platform-level access gate: which email domains may reach the product at
/// all. Deliberately SEPARATE from OrganizationDomain — that model answers
/// "does this domain belong to workspace X" for SSO enforcement, and
/// overloading it would let a customer verifying a domain silently grant
/// itself platform access.
///
/// COMPANY_EMAIL_DOMAINS (src/lib/auth/company-domain.ts) stays hardcoded and
/// is NOT represented here, so no table edit can lock staff out.
model PlatformAllowedDomain {
  id             String    @id @default(cuid())
  /// Bare hostname, lowercased. Exact match only — no wildcards.
  domain         String    @unique
  /// The shared workspace every user from this domain joins.
  organizationId String    @db.Uuid
  note           String    @default("")
  addedByUserId  String?
  createdAt      DateTime  @default(now()) @db.Timestamptz(6)
  /// Set to disable without losing the audit trail. Null = active.
  disabledAt     DateTime? @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([organizationId])
  @@map("platform_allowed_domains")
}
```

In the `Organization` model, add to the relation block (next to `domains OrganizationDomain[]`):

```prisma
  allowedDomains       PlatformAllowedDomain[]
```

- [ ] **Step 2: Generate the migration**

```bash
npx prisma migrate dev --name platform_allowed_domains
```

Expected: a new `prisma/migrations/<timestamp>_platform_allowed_domains/` directory, and `prisma generate` runs automatically.

- [ ] **Step 3: Write the failing test**

Create `src/lib/auth/__tests__/allowed-domain.db.test.ts`:

```ts
import { test, before } from 'node:test'
import assert from 'node:assert/strict'

// DB-gated: runs only under TEST_DATABASE_URL (CI-mode), like sibling DB tests.
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let isAllowedEmail: any
  let allowedDomainOrg: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ isAllowedEmail, allowedDomainOrg } = await import('@/lib/auth/allowed-domain'))

    const stamp = Date.now()
    const org = await prisma.organization.create({
      data: { name: 'Customer Co', slug: `customer-${stamp}` },
    })
    ids.org = org.id

    await prisma.platformAllowedDomain.create({
      data: { domain: `active-${stamp}.example`, organizationId: org.id },
    })
    await prisma.platformAllowedDomain.create({
      data: { domain: `disabled-${stamp}.example`, organizationId: org.id, disabledAt: new Date() },
    })
    ids.activeDomain = `active-${stamp}.example`
    ids.disabledDomain = `disabled-${stamp}.example`
  })

  test('hardcoded company domains are allowed without a table row', async () => {
    assert.equal(await isAllowedEmail('person@people.ai'), true)
    assert.equal(await isAllowedEmail('PERSON@BACKSTORY.AI'), true)
  })

  test('an active allowed domain opens the gate', async () => {
    assert.equal(await isAllowedEmail(`person@${ids.activeDomain}`), true)
  })

  test('a disabled domain is refused', async () => {
    assert.equal(await isAllowedEmail(`person@${ids.disabledDomain}`), false)
  })

  test('an unlisted domain is refused', async () => {
    assert.equal(await isAllowedEmail('person@stranger.example'), false)
    assert.equal(await isAllowedEmail(null), false)
  })

  test('lookalike domains do not inherit access', async () => {
    assert.equal(await isAllowedEmail(`person@${ids.activeDomain}.attacker.example`), false)
    assert.equal(await isAllowedEmail('person@people.ai.attacker.example'), false)
  })

  test('allowedDomainOrg returns the shared workspace, and null for company domains', async () => {
    assert.equal(await allowedDomainOrg(`person@${ids.activeDomain}`), ids.org)
    assert.equal(await allowedDomainOrg('person@people.ai'), null)
    assert.equal(await allowedDomainOrg(`person@${ids.disabledDomain}`), null)
  })
}
```

- [ ] **Step 4: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://postgres:ci@localhost:5432/ci_repro TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/auth/__tests__/allowed-domain.db.test.ts`
Expected: FAIL — cannot resolve `@/lib/auth/allowed-domain`.

(If no local Postgres is running, start one first — see the CI-mode repro note in the project README. Without `TEST_DATABASE_URL` the file silently passes with zero tests, which is NOT a green signal.)

- [ ] **Step 5: Write minimal implementation**

Create `src/lib/auth/allowed-domain.ts`:

```ts
/**
 * Platform access gate. A sign-in is admitted when the verified email's domain
 * is either a hardcoded company domain or an ACTIVE PlatformAllowedDomain row.
 *
 * Called once per sign-in (not per request), so a direct query is cheaper than
 * a cache plus the invalidation bug a cache would invite.
 *
 * systemPrisma: this runs BEFORE the caller has a workspace, so there is no
 * org context for RLS to scope to.
 */
import { systemPrisma } from '@/lib/prisma'
import { emailDomain } from '@/lib/auth/enterprise-policy'
import { isCompanyEmail } from '@/lib/auth/company-domain'

/** The active row for an email's domain, or null. Exact match only. */
async function activeRow(email: string | null | undefined) {
  const domain = emailDomain(email)
  if (!domain) return null
  return systemPrisma.platformAllowedDomain.findFirst({
    where: { domain, disabledAt: null },
    select: { organizationId: true },
  })
}

/** True when this verified email may hold a session on the platform. */
export async function isAllowedEmail(email: string | null | undefined): Promise<boolean> {
  if (isCompanyEmail(email)) return true
  return (await activeRow(email)) !== null
}

/**
 * The shared workspace a newly provisioned user from this domain should join,
 * or null when the domain has no allowlist row (company staff included — they
 * keep the existing invite/solo-workspace provisioning path).
 */
export async function allowedDomainOrg(email: string | null | undefined): Promise<string | null> {
  return (await activeRow(email))?.organizationId ?? null
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `TEST_DATABASE_URL=postgresql://postgres:ci@localhost:5432/ci_repro TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/auth/__tests__/allowed-domain.db.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 7: Run the full local gate**

```bash
npm run typecheck && npm run lint && npm test
```
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/auth/allowed-domain.ts src/lib/auth/__tests__/allowed-domain.db.test.ts
git commit -m "feat(auth): PlatformAllowedDomain model and platform access gate"
```

---

### Task 3: Wire the gate into sign-in and provisioning

**Files:**
- Modify: `src/app/auth/callback/route.ts:27-33`
- Modify: `src/lib/supabase/auth-utils.ts` (inside `provisionUser`)
- Test: `src/lib/auth/__tests__/allowed-domain.db.test.ts` (extend)

**Interfaces:**
- Consumes: `isAllowedEmail`, `allowedDomainOrg` (Task 2)
- Produces: no new exports; `provisionUser` behavior change only

- [ ] **Step 1: Write the failing test**

Append to `src/lib/auth/__tests__/allowed-domain.db.test.ts`, inside the `if (TEST_DB) { ... }` block:

```ts
  test('a user from an allowed domain joins the shared workspace as a member', async () => {
    const { provisionUserForTest } = await import('@/lib/supabase/auth-utils')
    const supabaseId = crypto.randomUUID()
    const created = await provisionUserForTest({
      id: supabaseId,
      email: `newhire@${ids.activeDomain}`,
      user_metadata: { full_name: 'New Hire' },
    } as any)

    assert.equal(created.organizationId, ids.org)
    assert.equal(created.role, 'USER')
  })

  test('a user from a company domain still gets their own workspace', async () => {
    const { provisionUserForTest } = await import('@/lib/supabase/auth-utils')
    const supabaseId = crypto.randomUUID()
    const created = await provisionUserForTest({
      id: supabaseId,
      email: `staff-${Date.now()}@people.ai`,
      user_metadata: { full_name: 'Staff Person' },
    } as any)

    assert.notEqual(created.organizationId, ids.org)
    assert.equal(created.role, 'ADMIN')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://postgres:ci@localhost:5432/ci_repro TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/auth/__tests__/allowed-domain.db.test.ts`
Expected: FAIL — `provisionUserForTest` is not exported.

- [ ] **Step 3: Add the allowlist branch to `provisionUser`**

In `src/lib/supabase/auth-utils.ts`, add the import at the top:

```ts
import { allowedDomainOrg } from '@/lib/auth/allowed-domain'
```

Inside `provisionUser`, resolve the allowlist org before opening the transaction — replace the line `const inviteEmail = user.email?.trim().toLowerCase() || null` and what follows it up to `try {` with:

```ts
  const inviteEmail = user.email?.trim().toLowerCase() || null
  // An allowed customer domain routes every user into ONE shared workspace
  // rather than spawning a solo org each. Resolved outside the transaction:
  // it is a read against a table the transaction never writes.
  const domainOrgId = await allowedDomainOrg(user.email)
```

Then inside the transaction, replace the `organizationId` assignment:

```ts
      // Precedence: an explicit invitation beats the domain rule (someone
      // invited to a specific workspace goes there), which beats a fresh org.
      const organizationId = invite
        ? invite.organizationId
        : domainOrgId
          ? domainOrgId
          : (await tx.organization.create({ data: { name: orgName, slug: `org-${user.id}` } })).id
```

And replace the `role` assignment in the `tx.user.create` call:

```ts
          // Fresh solo workspaces make their founder ADMIN. Joining an existing
          // workspace — by invite or by domain rule — must not, or the first
          // customer to sign in would own the shared org.
          role: invite ? (invite.role === 'ADMIN' ? 'ADMIN' : 'USER') : domainOrgId ? 'USER' : 'ADMIN',
```

- [ ] **Step 4: Export a test seam**

At the end of `src/lib/supabase/auth-utils.ts`, add:

```ts
/** Test-only seam: provisioning is otherwise reached solely via getAuthWithUser. */
export const provisionUserForTest = provisionUser
```

- [ ] **Step 5: Swap the callback gate**

In `src/app/auth/callback/route.ts`, replace the import:

```ts
import { isAllowedEmail } from '@/lib/auth/allowed-domain'
```

and change the gate condition (currently `!isCompanyEmail(user?.email)`):

```ts
  const { data: { user }, error: userError } = await supabase.auth.getUser()
  if (userError || !(await isAllowedEmail(user?.email))) {
    await supabase.auth.signOut().catch(() => undefined)
    const errorUrl = new URL('/auth/auth-code-error', request.url)
    errorUrl.searchParams.set('reason', userError ? 'session' : 'domain')
    return NextResponse.redirect(errorUrl)
  }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `TEST_DATABASE_URL=postgresql://postgres:ci@localhost:5432/ci_repro TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/auth/__tests__/allowed-domain.db.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 7: Run the full local gate**

```bash
npm run typecheck && npm run lint && npm test
```
Expected: all pass. The existing `company-domain.test.ts` must still pass untouched — `isCompanyEmail` was not modified.

- [ ] **Step 8: Commit**

```bash
git add src/app/auth/callback/route.ts src/lib/supabase/auth-utils.ts src/lib/auth/__tests__/allowed-domain.db.test.ts
git commit -m "feat(auth): admit allowed domains at sign-in and route them to a shared workspace"
```

---

### Task 4: Admin API and UI

**Files:**
- Create: `src/app/api/admin/domains/route.ts`
- Create: `src/app/admin/domains/page.tsx`

**Interfaces:**
- Consumes: `normalizeDomain`, `isPublicEmailProvider` (Task 1); `recordAudit` from `@/lib/audit`; `withAuthenticatedApi`, `ApiError` from `@/lib/server/api-handler`
- Produces: `GET /api/admin/domains`, `POST /api/admin/domains`, `PATCH /api/admin/domains`

- [ ] **Step 1: Write the API route**

Create `src/app/api/admin/domains/route.ts`:

```ts
import { z } from 'zod'
import { systemPrisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordAudit } from '@/lib/audit'
import { normalizeDomain, isPublicEmailProvider, COMPANY_EMAIL_DOMAINS } from '@/lib/auth/company-domain'

const postSchema = z.object({
  domain: z.string().min(1),
  organizationId: z.string().uuid(),
  note: z.string().max(500).optional(),
})

const patchSchema = z.object({
  id: z.string().min(1),
  disabled: z.boolean(),
  /** When disabling, also deactivate that domain's users immediately. */
  deactivateUsers: z.boolean().optional(),
})

// Platform-wide access administration. systemPrisma throughout: granting a
// company access necessarily reaches across workspaces, which is why this sits
// behind catalogue.review rather than in org settings — an org admin must never
// be able to grant their own domain access.
export const GET = withAuthenticatedApi(async () => {
  const domains = await systemPrisma.platformAllowedDomain.findMany({
    select: {
      id: true,
      domain: true,
      note: true,
      createdAt: true,
      disabledAt: true,
      organizationId: true,
      organization: { select: { name: true, slug: true } },
    },
    orderBy: { domain: 'asc' },
    take: 500,
  })
  const organizations = await systemPrisma.organization.findMany({
    select: { id: true, name: true, slug: true, kind: true },
    orderBy: { name: 'asc' },
    take: 500,
  })
  return { success: true, domains, organizations, companyDomains: COMPANY_EMAIL_DOMAINS }
}, { permission: 'catalogue.review' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = postSchema.parse(await request.json())

  const domain = normalizeDomain(data.domain)
  if (!domain) {
    throw new ApiError('Enter a plain domain such as customer.com — no wildcards, paths, or full email addresses.', 400, 'INVALID_DOMAIN')
  }
  if (isPublicEmailProvider(domain)) {
    throw new ApiError('That is a public email provider. Allowing it would let anyone with an email address into the platform.', 400, 'PUBLIC_EMAIL_PROVIDER')
  }
  if ((COMPANY_EMAIL_DOMAINS as readonly string[]).includes(domain)) {
    throw new ApiError('That domain already has permanent access and does not need an entry.', 400, 'COMPANY_DOMAIN')
  }

  const organization = await systemPrisma.organization.findUnique({
    where: { id: data.organizationId },
    select: { id: true },
  })
  if (!organization) throw new ApiError('That workspace no longer exists.', 404, 'NOT_FOUND')

  const existing = await systemPrisma.platformAllowedDomain.findUnique({ where: { domain } })
  if (existing) {
    throw new ApiError('That domain is already listed. Re-enable it instead of adding it again.', 409, 'DOMAIN_EXISTS')
  }

  const created = await systemPrisma.platformAllowedDomain.create({
    data: {
      domain,
      organizationId: data.organizationId,
      note: data.note ?? '',
      addedByUserId: auth.dbUser.id,
    },
    select: { id: true, domain: true },
  })

  await recordAudit({
    organizationId: auth.organizationId,
    action: 'platform.domain_allowed',
    actorUserId: auth.dbUser.id,
    resourceType: 'platform_allowed_domain',
    resourceId: created.id,
    detail: { domain: created.domain, organizationId: data.organizationId },
  })

  return { success: true, domain: created }
}, { permission: 'catalogue.review' })

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const data = patchSchema.parse(await request.json())

  const row = await systemPrisma.platformAllowedDomain.findUnique({
    where: { id: data.id },
    select: { id: true, domain: true, organizationId: true },
  })
  if (!row) throw new ApiError('That domain entry no longer exists.', 404, 'NOT_FOUND')

  await systemPrisma.platformAllowedDomain.update({
    where: { id: data.id },
    data: { disabledAt: data.disabled ? new Date() : null },
  })

  // Disabling blocks NEW sign-ins at once, but live sessions survive until they
  // expire. Deactivating the domain's users is therefore a separate, explicit
  // choice rather than a silent side effect of a config edit.
  let deactivated = 0
  if (data.disabled && data.deactivateUsers) {
    const result = await systemPrisma.user.updateMany({
      where: { organizationId: row.organizationId, email: { endsWith: `@${row.domain}` }, isActive: true },
      data: { isActive: false },
    })
    deactivated = result.count
  }

  await recordAudit({
    organizationId: auth.organizationId,
    action: data.disabled ? 'platform.domain_disabled' : 'platform.domain_reenabled',
    actorUserId: auth.dbUser.id,
    resourceType: 'platform_allowed_domain',
    resourceId: row.id,
    detail: { domain: row.domain, deactivatedUsers: deactivated },
  })

  return { success: true, deactivated }
}, { permission: 'catalogue.review' })
```

- [ ] **Step 2: Verify types and lint**

```bash
npm run typecheck && npm run lint
```
Expected: pass. If `ApiError`'s constructor signature differs, match the usage in `src/features/flows/execute-flow.ts` (`new ApiError(message, status, code)`).

- [ ] **Step 3: Commit the API**

```bash
git add src/app/api/admin/domains/route.ts
git commit -m "feat(admin): platform allowed-domain API"
```

- [ ] **Step 4: Write the admin page**

Create `src/app/admin/domains/page.tsx`:

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

type DomainRow = {
  id: string
  domain: string
  note: string
  createdAt: string
  disabledAt: string | null
  organizationId: string
  organization: { name: string; slug: string } | null
}

type OrgRow = { id: string; name: string; slug: string; kind: string }

export default function DomainsPage() {
  const [domains, setDomains] = useState<DomainRow[]>([])
  const [organizations, setOrganizations] = useState<OrgRow[]>([])
  const [companyDomains, setCompanyDomains] = useState<string[]>([])
  const [domain, setDomain] = useState('')
  const [organizationId, setOrganizationId] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const response = await fetch('/api/admin/domains', { cache: 'no-store' })
    const data = await response.json()
    if (!response.ok) {
      toast.error(data.error || 'Could not load domains.')
      return
    }
    setDomains(data.domains)
    setOrganizations(data.organizations)
    setCompanyDomains(data.companyDomains)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const add = async () => {
    if (!domain.trim() || !organizationId) {
      toast.error('Enter a domain and choose the workspace its people should join.')
      return
    }
    setBusy(true)
    const response = await fetch('/api/admin/domains', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain, organizationId, note }),
    })
    const data = await response.json()
    setBusy(false)
    if (!response.ok) {
      toast.error(data.error || 'Could not add that domain.')
      return
    }
    toast.success(`${data.domain.domain} can now sign in.`)
    setDomain('')
    setNote('')
    await load()
  }

  const setDisabled = async (row: DomainRow, disabled: boolean) => {
    let deactivateUsers = false
    if (disabled) {
      deactivateUsers = window.confirm(
        `Blocking ${row.domain} stops new sign-ins immediately, but people already signed in keep their session until it expires.\n\n` +
          'Click OK to also sign out and deactivate their accounts now. Click Cancel to block new sign-ins only.',
      )
    }
    setBusy(true)
    const response = await fetch('/api/admin/domains', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: row.id, disabled, deactivateUsers }),
    })
    const data = await response.json()
    setBusy(false)
    if (!response.ok) {
      toast.error(data.error || 'Could not update that domain.')
      return
    }
    toast.success(
      disabled
        ? `${row.domain} blocked${data.deactivated ? ` — ${data.deactivated} account(s) deactivated.` : '.'}`
        : `${row.domain} re-enabled.`,
    )
    await load()
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Platform access</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Which email domains may sign in. {companyDomains.join(' and ')} always have access and cannot be removed here.
        </p>
      </header>

      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="text-sm font-medium">Allow a customer domain</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <input
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            placeholder="customer.com"
            className="rounded-md border px-3 py-2 text-sm"
          />
          <select
            value={organizationId}
            onChange={(event) => setOrganizationId(event.target.value)}
            className="rounded-md border px-3 py-2 text-sm"
          >
            <option value="">Workspace they join…</option>
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name} ({org.kind})
              </option>
            ))}
          </select>
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Note (optional)"
            className="rounded-md border px-3 py-2 text-sm"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Everyone signing in from this domain joins the chosen workspace as a member. Public email providers such as
          gmail.com are refused — allowing one would let anyone with an email address in.
        </p>
        <button
          onClick={() => void add()}
          disabled={busy}
          className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
        >
          Allow domain
        </button>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Allowed domains</h2>
        {domains.length === 0 && <p className="text-sm text-muted-foreground">No customer domains yet.</p>}
        <ul className="divide-y rounded-lg border">
          {domains.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {row.domain}
                  {row.disabledAt && <span className="ml-2 text-xs text-muted-foreground">blocked</span>}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  joins {row.organization?.name ?? 'unknown workspace'}
                  {row.note ? ` — ${row.note}` : ''}
                </p>
              </div>
              <button
                onClick={() => void setDisabled(row, !row.disabledAt)}
                disabled={busy}
                className="shrink-0 rounded-md border px-3 py-1.5 text-xs disabled:opacity-50"
              >
                {row.disabledAt ? 'Re-enable' : 'Block'}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
```

- [ ] **Step 5: Run the full local gate**

```bash
npm run typecheck && npm run lint && npm test
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/app/admin/domains/page.tsx
git commit -m "feat(admin): platform access screen for customer domains"
```

---

# WORKSTREAM B — Four-Bucket Token Usage

Fixes a live correctness bug and is the prerequisite for Workstream C. Pure refactor: no schema, no behavior change.

---

### Task 5: Split usage into four buckets

**Files:**
- Modify: `src/lib/llm/model-runner.ts:32-36` (type), `:146-152` (mapping)
- Modify: `src/lib/eval/scripted-runner.ts:60`
- Modify: `src/lib/eval/harness.ts:44-45`
- Modify: `src/features/agents/execute-agent.ts:934-936, 943`
- Modify: `src/features/flows/execute-flow.ts:825`
- Test: `src/lib/llm/__tests__/usage.test.ts` (create)

**Interfaces:**
- Consumes: nothing
- Produces: `TokenUsage` type `{ inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens }`; `billableTokens(usage: TokenUsage): number`; `ModelTurn` gains `provider: ProviderKind` and `servedModel: string`

- [ ] **Step 1: Write the failing test**

Create `src/lib/llm/__tests__/usage.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { billableTokens, emptyUsage } from '@/lib/llm/model-runner'

test('billableTokens counts every input bucket plus output', () => {
  assert.equal(
    billableTokens({ inputTokens: 100, cacheWriteTokens: 40, cacheReadTokens: 900, outputTokens: 60 }),
    1100,
  )
})

test('billableTokens matches the pre-split total so budget enforcement is unchanged', () => {
  // Before the split, inputTokens was input+cacheWrite+cacheRead and callers
  // summed it with outputTokens. This must still produce the same number.
  const legacyInput = 100 + 40 + 900
  assert.equal(
    billableTokens({ inputTokens: 100, cacheWriteTokens: 40, cacheReadTokens: 900, outputTokens: 60 }),
    legacyInput + 60,
  )
})

test('emptyUsage is all zeros', () => {
  assert.deepEqual(emptyUsage(), {
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/llm/__tests__/usage.test.ts`
Expected: FAIL — `billableTokens` is not exported.

- [ ] **Step 3: Change the type and add helpers**

In `src/lib/llm/model-runner.ts`, replace the `ModelTurn` type:

```ts
/**
 * Token counts split by BILLING bucket. Cache reads bill at roughly 0.1x and
 * cache writes at roughly 1.25x, so collapsing these into one number (as this
 * type previously did) makes the total impossible to convert to dollars —
 * especially here, where withRollingCache means most turns are cache-heavy.
 */
export type TokenUsage = {
  inputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  outputTokens: number
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }
}

/**
 * Total tokens for quota purposes — every input bucket plus output. This is
 * exactly what `inputTokens + outputTokens` meant before the split, so callers
 * enforcing budgets keep their current behavior.
 */
export function billableTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens + usage.outputTokens
}

export type ModelTurn = {
  text: string
  toolCalls: ToolCall[]
  usage: TokenUsage
  /** Which endpoint actually served this turn — the chain may have fallen back. */
  provider: ProviderKind
  /** The model string actually sent, which may differ from the one requested. */
  servedModel: string
}
```

- [ ] **Step 4: Fix the provider mapping**

In `AnthropicProvider.next()`, replace the returned `usage` block and add the two new fields:

```ts
      usage: {
        inputTokens: message.usage.input_tokens,
        cacheWriteTokens: message.usage.cache_creation_input_tokens || 0,
        cacheReadTokens: message.usage.cache_read_input_tokens || 0,
        outputTokens: message.usage.output_tokens,
      },
      provider: this.kind,
      servedModel: this.model,
```

- [ ] **Step 5: Update every consumer to preserve behavior**

`src/lib/eval/scripted-runner.ts:60` — replace the literal:

```ts
    return { text, toolCalls, usage: emptyUsage(), provider: 'anthropic' as const, servedModel: 'scripted' }
```

and add `emptyUsage` to its import from `@/lib/llm/model-runner`.

`src/lib/eval/harness.ts:44-45` — replace the two accumulator lines:

```ts
    trajectory.usage.inputTokens += billableTokens(result.usage) - result.usage.outputTokens
    trajectory.usage.outputTokens += result.usage.outputTokens
```

and add `billableTokens` to its import from `@/lib/llm/model-runner`. (`Trajectory.usage` keeps its two-field shape — it is display-only and its consumers are unchanged.)

`src/features/agents/execute-agent.ts:934-936` — replace the three accumulator lines:

```ts
      usage.inputTokens += billableTokens(turnResult.usage) - turnResult.usage.outputTokens
      usage.outputTokens += turnResult.usage.outputTokens
      treeTokens.used += billableTokens(turnResult.usage)
```

and line 943:

```ts
      const monthTotal = await recordTokenUsage(organizationId, billableTokens(turnResult.usage))
```

Add `billableTokens` to the existing `@/lib/llm/model-runner` import.

`src/features/flows/execute-flow.ts:825` — replace the argument:

```ts
          billableTokens(turn.usage),
```

Add `billableTokens` to the existing `@/lib/llm/model-runner` import.

- [ ] **Step 6: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/llm/__tests__/usage.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 7: Run the full local gate**

```bash
npm run typecheck && npm run lint && npm test
```
Expected: all pass. Typecheck is the real safety net here — it will flag any `usage` consumer missed in Step 5.

- [ ] **Step 8: Commit**

```bash
git add src/lib/llm src/lib/eval/harness.ts src/lib/eval/scripted-runner.ts src/features/agents/execute-agent.ts src/features/flows/execute-flow.ts
git commit -m "fix(llm): split token usage into billing buckets

Cache reads bill ~0.1x and cache writes ~1.25x, but all three input buckets
were summed into one field, making the stored total impossible to convert to
dollars. Splits them and threads the served provider/model through ModelTurn.
billableTokens() preserves the previous total exactly at every consumer."
```

---

# WORKSTREAM C — Cost Ledger

Depends on Workstream B.

---

### Task 6: Pricing table

**Files:**
- Create: `src/lib/usage/pricing.ts`
- Test: `src/lib/usage/__tests__/pricing.test.ts`

**Interfaces:**
- Consumes: `TokenUsage` (Task 5)
- Produces: `PRICE_VERSION: string`, `computeCostUsd(provider: string, model: string, usage: TokenUsage): { costUsd: number; priceVersion: string }`

- [ ] **Step 1: Write the failing test**

Create `src/lib/usage/__tests__/pricing.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { computeCostUsd, PRICE_VERSION } from '@/lib/usage/pricing'

const usage = { inputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }

test('a known model prices input tokens from the table', () => {
  const result = computeCostUsd('anthropic', 'claude-sonnet-5', usage)
  assert.equal(result.priceVersion, PRICE_VERSION)
  assert.ok(result.costUsd > 0, 'expected a positive cost')
})

test('cache reads cost far less than fresh input for the same token count', () => {
  const fresh = computeCostUsd('anthropic', 'claude-sonnet-5', {
    inputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0,
  })
  const cached = computeCostUsd('anthropic', 'claude-sonnet-5', {
    inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 1_000_000, outputTokens: 0,
  })
  assert.ok(cached.costUsd < fresh.costUsd / 5, 'cache reads must be dramatically cheaper')
})

test('cache writes cost more than fresh input for the same token count', () => {
  const fresh = computeCostUsd('anthropic', 'claude-sonnet-5', {
    inputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0,
  })
  const written = computeCostUsd('anthropic', 'claude-sonnet-5', {
    inputTokens: 0, cacheWriteTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0,
  })
  assert.ok(written.costUsd > fresh.costUsd)
})

test('an unknown model costs zero and is flagged rather than throwing', () => {
  const result = computeCostUsd('anthropic', 'claude-model-from-the-future', usage)
  assert.equal(result.costUsd, 0)
  assert.equal(result.priceVersion, 'unknown')
})

test('embedding models price input only', () => {
  const result = computeCostUsd('voyage', 'voyage-3', {
    inputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 5_000,
  })
  assert.ok(result.costUsd > 0)
  assert.equal(result.priceVersion, PRICE_VERSION)
})

test('cost is rounded to six decimal places to match the Decimal(12,6) column', () => {
  const result = computeCostUsd('anthropic', 'claude-sonnet-5', {
    inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0,
  })
  const decimals = String(result.costUsd).split('.')[1] ?? ''
  assert.ok(decimals.length <= 6, `expected <=6 decimals, got ${result.costUsd}`)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/usage/__tests__/pricing.test.ts`
Expected: FAIL — cannot resolve `@/lib/usage/pricing`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/usage/pricing.ts`:

```ts
/**
 * Model price table, in USD per MILLION tokens.
 *
 * This is for INTERNAL ops visibility, not invoicing — it is not reconciled
 * against provider invoices and is not a billing source of truth. Cost is
 * computed and snapshotted at write time, so bumping PRICE_VERSION never
 * rewrites history.
 *
 * When prices change: update the rates AND bump PRICE_VERSION.
 */
import type { TokenUsage } from '@/lib/llm/model-runner'

export const PRICE_VERSION = '2026-08-03'

type Rates = {
  /** Fresh (uncached) input tokens. */
  input: number
  /** Cache writes — typically 1.25x input. */
  cacheWrite: number
  /** Cache reads — typically 0.1x input. */
  cacheRead: number
  output: number
}

const PER_MILLION: Record<string, Rates> = {
  'anthropic:claude-opus-5': { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  'anthropic:claude-opus-4-8': { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  'anthropic:claude-sonnet-5': { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  'anthropic:claude-fable-5': { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  'anthropic:claude-haiku-4-5': { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  'voyage:voyage-3': { input: 0.06, cacheWrite: 0.06, cacheRead: 0.06, output: 0 },
}

/**
 * Match a model string to a rate row. Exact match first, then longest-prefix —
 * so a dated variant (claude-sonnet-5-20260101) prices as its family rather
 * than falling through to unknown.
 */
function ratesFor(provider: string, model: string): Rates | null {
  const key = `${provider}:${model}`
  if (PER_MILLION[key]) return PER_MILLION[key]

  let best: { length: number; rates: Rates } | null = null
  for (const [candidate, rates] of Object.entries(PER_MILLION)) {
    if (key.startsWith(candidate) && (!best || candidate.length > best.length)) {
      best = { length: candidate.length, rates }
    }
  }
  return best?.rates ?? null
}

/**
 * Cost in USD for one call. An unknown model yields 0 with priceVersion
 * 'unknown' rather than throwing — a newly released model must never break a
 * run, and the flag makes the gap visible in the admin view.
 */
export function computeCostUsd(
  provider: string,
  model: string,
  usage: TokenUsage,
): { costUsd: number; priceVersion: string } {
  const rates = ratesFor(provider, model)
  if (!rates) return { costUsd: 0, priceVersion: 'unknown' }

  const raw =
    (usage.inputTokens * rates.input +
      usage.cacheWriteTokens * rates.cacheWrite +
      usage.cacheReadTokens * rates.cacheRead +
      usage.outputTokens * rates.output) /
    1_000_000

  // Six decimals matches the Decimal(12,6) column; rounding here keeps the
  // stored value and the computed value identical.
  return { costUsd: Math.round(raw * 1e6) / 1e6, priceVersion: PRICE_VERSION }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/usage/__tests__/pricing.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/usage/pricing.ts src/lib/usage/__tests__/pricing.test.ts
git commit -m "feat(usage): model price table and per-bucket cost computation"
```

---

### Task 7: LlmCall schema and ledger writer

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `src/lib/usage/ledger.ts`
- Test: `src/lib/usage/__tests__/ledger.db.test.ts`

**Interfaces:**
- Consumes: `computeCostUsd`, `PRICE_VERSION` (Task 6); `TokenUsage` (Task 5)
- Produces: `LlmSurface` type; `recordLlmCall(input: LlmCallInput): Promise<void>`

- [ ] **Step 1: Add the Prisma model**

In `prisma/schema.prisma`, add:

```prisma
/// One LLM or embedding API call. Detail rows for internal cost visibility;
/// denormalized totals live on AgentExecution/FlowRun so list views never
/// aggregate. Rows older than 90 days are swept by the retention cron — the
/// totals survive, so historical run cost stays visible after detail ages out.
model LlmCall {
  id               String   @id @default(cuid())
  organizationId   String   @db.Uuid
  agentExecutionId String?
  flowRunId        String?
  flowRunStepId    String?
  /// agent_turn | structured | headline | embedding | eval_judge
  surface          String
  provider         String
  model            String
  inputTokens      Int      @default(0)
  cacheWriteTokens Int      @default(0)
  cacheReadTokens  Int      @default(0)
  outputTokens     Int      @default(0)
  costUsd          Decimal  @default(0) @db.Decimal(12, 6)
  /// Which price table produced costUsd. 'unknown' means the model had no rate.
  priceVersion     String
  createdAt        DateTime @default(now())

  @@index([organizationId, createdAt])
  @@index([flowRunId])
  @@map("llm_calls")
}
```

Add to `AgentExecution`:

```prisma
  costUsd         Decimal   @default(0) @db.Decimal(12, 6)
```

Add to `FlowRun`:

```prisma
  costUsd           Decimal   @default(0) @db.Decimal(12, 6)
```

Note: `LlmCall` intentionally declares no relation fields. The foreign keys are nullable and cross three different parents; keeping them as plain columns avoids three optional relations on hot models for a table that is only ever queried directly.

- [ ] **Step 2: Generate the migration**

```bash
npx prisma migrate dev --name llm_call_ledger
```

- [ ] **Step 3: Write the failing test**

Create `src/lib/usage/__tests__/ledger.db.test.ts`:

```ts
import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let recordLlmCall: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ recordLlmCall } = await import('@/lib/usage/ledger'))

    const stamp = Date.now()
    const org = await prisma.organization.create({ data: { name: 'Ledger', slug: `ledger-${stamp}` } })
    ids.org = org.id
    const user = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), email: `ledger-${stamp}@example.com`, name: 'L', organizationId: org.id },
    })
    ids.user = user.id
    const execution = await prisma.agentExecution.create({
      data: { agentType: 'CUSTOM', status: 'succeeded', input: {}, trigger: {}, userId: user.id, organizationId: org.id },
    })
    ids.execution = execution.id
  })

  test('a call writes a detail row with split buckets and a positive cost', async () => {
    await recordLlmCall({
      organizationId: ids.org,
      agentExecutionId: ids.execution,
      surface: 'agent_turn',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      usage: { inputTokens: 1000, cacheWriteTokens: 200, cacheReadTokens: 5000, outputTokens: 300 },
    })

    const rows = await prisma.llmCall.findMany({ where: { agentExecutionId: ids.execution } })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].inputTokens, 1000)
    assert.equal(rows[0].cacheWriteTokens, 200)
    assert.equal(rows[0].cacheReadTokens, 5000)
    assert.equal(rows[0].outputTokens, 300)
    assert.equal(rows[0].surface, 'agent_turn')
    assert.ok(Number(rows[0].costUsd) > 0)
  })

  test('the execution rollup accumulates across calls', async () => {
    await recordLlmCall({
      organizationId: ids.org,
      agentExecutionId: ids.execution,
      surface: 'agent_turn',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      usage: { inputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 100 },
    })

    const execution = await prisma.agentExecution.findUnique({ where: { id: ids.execution } })
    const rows = await prisma.llmCall.findMany({ where: { agentExecutionId: ids.execution } })
    const detailSum = rows.reduce((total: number, row: any) => total + Number(row.costUsd), 0)
    assert.ok(Math.abs(Number(execution.costUsd) - detailSum) < 1e-6, 'rollup must equal the sum of detail rows')
  })

  test('an unattached call (no execution or run) still records', async () => {
    await recordLlmCall({
      organizationId: ids.org,
      surface: 'headline',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      usage: { inputTokens: 500, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 20 },
    })

    const rows = await prisma.llmCall.findMany({ where: { organizationId: ids.org, surface: 'headline' } })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].agentExecutionId, null)
  })

  test('a ledger failure never throws into the caller', async () => {
    // A non-existent org would violate nothing at the column level but the
    // write is best-effort regardless — the contract is that it cannot throw.
    await recordLlmCall({
      organizationId: '00000000-0000-0000-0000-000000000000',
      surface: 'structured',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      usage: { inputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1 },
    })
    assert.ok(true, 'recordLlmCall resolved without throwing')
  })
}
```

- [ ] **Step 4: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://postgres:ci@localhost:5432/ci_repro TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/usage/__tests__/ledger.db.test.ts`
Expected: FAIL — cannot resolve `@/lib/usage/ledger`.

- [ ] **Step 5: Write minimal implementation**

Create `src/lib/usage/ledger.ts`:

```ts
/**
 * Per-call cost ledger. Writes one LlmCall detail row and increments the
 * denormalized total on its parent execution/run.
 *
 * BEST EFFORT: a ledger failure is logged and swallowed, never thrown. A
 * dropped row under-reports cost; a run failing because billing telemetry
 * hiccuped is unacceptable. Same posture as recordTokenUsage.
 */
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import type { TokenUsage } from '@/lib/llm/model-runner'
import { computeCostUsd } from './pricing'

export type LlmSurface = 'agent_turn' | 'structured' | 'headline' | 'embedding' | 'eval_judge'

export type LlmCallInput = {
  organizationId: string
  surface: LlmSurface
  provider: string
  model: string
  usage: TokenUsage
  agentExecutionId?: string | null
  flowRunId?: string | null
  flowRunStepId?: string | null
}

export async function recordLlmCall(input: LlmCallInput): Promise<void> {
  try {
    const { costUsd, priceVersion } = computeCostUsd(input.provider, input.model, input.usage)

    await systemPrisma.llmCall.create({
      data: {
        organizationId: input.organizationId,
        agentExecutionId: input.agentExecutionId ?? null,
        flowRunId: input.flowRunId ?? null,
        flowRunStepId: input.flowRunStepId ?? null,
        surface: input.surface,
        provider: input.provider,
        model: input.model,
        inputTokens: input.usage.inputTokens,
        cacheWriteTokens: input.usage.cacheWriteTokens,
        cacheReadTokens: input.usage.cacheReadTokens,
        outputTokens: input.usage.outputTokens,
        costUsd,
        priceVersion,
      },
    })

    if (costUsd > 0 && input.agentExecutionId) {
      await systemPrisma.agentExecution.update({
        where: { id: input.agentExecutionId },
        data: { costUsd: { increment: costUsd } },
      })
    }
    if (costUsd > 0 && input.flowRunId) {
      await systemPrisma.flowRun.update({
        where: { id: input.flowRunId },
        data: { costUsd: { increment: costUsd } },
      })
    }
  } catch (error) {
    apiLogger.warn('llm ledger write failed', {
      surface: input.surface,
      model: input.model,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error),
    })
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `TEST_DATABASE_URL=postgresql://postgres:ci@localhost:5432/ci_repro TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/usage/__tests__/ledger.db.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 7: Run the full local gate**

```bash
npm run typecheck && npm run lint && npm test
```

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/usage/ledger.ts src/lib/usage/__tests__/ledger.db.test.ts
git commit -m "feat(usage): LlmCall ledger with denormalized cost rollups"
```

---

### Task 8: Wire the four capture points

**Files:**
- Modify: `src/lib/llm/model-runner.ts` (`AnthropicProvider.next`, `generateHeadline`, `anthropicWireStructured`)
- Modify: `src/lib/rag/embeddings.ts:107`
- Modify: `src/features/agents/execute-agent.ts`, `src/features/flows/execute-flow.ts` (pass context)

**Interfaces:**
- Consumes: `recordLlmCall`, `LlmSurface` (Task 7)
- Produces: optional `LedgerContext` param `{ organizationId, agentExecutionId?, flowRunId?, flowRunStepId?, surface? }` threaded onto `ModelRunner.next`, `generateStructured`, `generateHeadline`, and `embed`

- [ ] **Step 1: Add the context type**

In `src/lib/llm/model-runner.ts`, add near `ToolDefinition`:

```ts
/**
 * Who to bill a call to. Optional everywhere: a call without context still
 * runs, it just is not recorded. Keeps every existing caller compiling
 * unchanged while new call sites opt in.
 */
export type LedgerContext = {
  organizationId: string
  surface?: 'agent_turn' | 'structured' | 'headline' | 'embedding' | 'eval_judge'
  agentExecutionId?: string | null
  flowRunId?: string | null
  flowRunStepId?: string | null
}
```

Extend the `ModelRunner` interface's `next` signature:

```ts
  next(transcript: unknown[], system: string, tools: ToolDefinition[], ledger?: LedgerContext): Promise<ModelTurn>
```

- [ ] **Step 2: Record in `AgentRunner.next`**

Record once in `AgentRunner.next` rather than inside each provider, so a fallback records exactly one row for the turn that actually succeeded. Replace the `try` body:

```ts
      try {
        const turn = await provider.next(ir, system, tools)
        if (ledger) {
          void recordLlmCall({
            organizationId: ledger.organizationId,
            surface: ledger.surface ?? 'agent_turn',
            provider: turn.provider,
            model: turn.servedModel,
            usage: turn.usage,
            agentExecutionId: ledger.agentExecutionId,
            flowRunId: ledger.flowRunId,
            flowRunStepId: ledger.flowRunStepId,
          })
        }
        return turn
      } catch (error) {
```

Add the import at the top of the file:

```ts
import { recordLlmCall } from '@/lib/usage/ledger'
```

- [ ] **Step 3: Record in `generateHeadline` and `anthropicWireStructured`**

In `generateHeadline`, add an optional `ledger?: LedgerContext` parameter and record after the response:

```ts
export async function generateHeadline(summary: string, ledger?: LedgerContext): Promise<string | null> {
```

immediately after `const response = await client.messages.create({...})`:

```ts
    if (ledger) {
      void recordLlmCall({
        organizationId: ledger.organizationId,
        surface: 'headline',
        provider: target.target === 'qwen' ? 'qwen' : 'anthropic',
        model: target.model,
        usage: {
          inputTokens: response.usage.input_tokens,
          cacheWriteTokens: response.usage.cache_creation_input_tokens || 0,
          cacheReadTokens: response.usage.cache_read_input_tokens || 0,
          outputTokens: response.usage.output_tokens,
        },
        agentExecutionId: ledger.agentExecutionId,
      })
    }
```

In `anthropicWireStructured`, add `ledger` and `provider` parameters and record identically with `surface: ledger.surface ?? 'structured'`:

```ts
async function anthropicWireStructured(
  opts: StructuredOpts,
  client: Anthropic,
  model: string,
  provider: 'anthropic' | 'qwen',
): Promise<string> {
  const response = await client.messages.create({
    model,
    max_tokens: opts.maxTokens ?? 4096,
    system: opts.system,
    messages: [{ role: 'user', content: opts.user }],
    output_config: { format: { type: 'json_schema', schema: strictifySchema(opts.schema) } },
  })
  if (opts.ledger) {
    void recordLlmCall({
      organizationId: opts.ledger.organizationId,
      surface: opts.ledger.surface ?? 'structured',
      provider,
      model,
      usage: {
        inputTokens: response.usage.input_tokens,
        cacheWriteTokens: response.usage.cache_creation_input_tokens || 0,
        cacheReadTokens: response.usage.cache_read_input_tokens || 0,
        outputTokens: response.usage.output_tokens,
      },
      agentExecutionId: opts.ledger.agentExecutionId,
      flowRunId: opts.ledger.flowRunId,
    })
  }
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
}
```

Add `ledger?: LedgerContext` to the `StructuredOpts` type, and update both call sites inside `generateStructured` to pass the provider:

```ts
      return target === 'qwen'
        ? await anthropicWireStructured(opts, qwenClient(), qwenModel(FALLBACK_QWEN_MODEL), 'qwen')
        : await anthropicWireStructured(opts, claudeClient(), claudeModel, 'anthropic')
```

- [ ] **Step 4: Record embeddings**

In `src/lib/rag/embeddings.ts`, add an optional `ledger` field to the options object the embed function already accepts, and after the Voyage response parses successfully, record:

```ts
  if (options.ledger) {
    const { recordLlmCall } = await import('@/lib/usage/ledger')
    void recordLlmCall({
      organizationId: options.ledger.organizationId,
      surface: 'embedding',
      provider: 'voyage',
      model,
      usage: {
        inputTokens: payload.usage?.total_tokens ?? 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
      },
    })
  }
```

(The dynamic import keeps `embeddings.ts` free of a static Prisma dependency, which matters because it is also exercised by the RAG eval outside a request context.)

- [ ] **Step 5: Pass context from the executors**

In `src/features/agents/execute-agent.ts`, at the `runner.next(...)` call, pass:

```ts
        { organizationId, surface: 'agent_turn', agentExecutionId: executionId },
```

In `src/features/flows/execute-flow.ts`, at its `runner.next(...)` call, pass:

```ts
        { organizationId, surface: 'agent_turn', flowRunId: run.id },
```

Use whatever the local identifier for the execution/run id is at each site — verify by reading the surrounding scope.

- [ ] **Step 6: Run the full local gate**

```bash
npm run typecheck && npm run lint && npm test
```
Expected: all pass. All existing callers of `next`/`generateStructured`/`generateHeadline` compile unchanged because every new parameter is optional.

- [ ] **Step 7: Commit**

```bash
git add src/lib/llm/model-runner.ts src/lib/rag/embeddings.ts src/features/agents/execute-agent.ts src/features/flows/execute-flow.ts
git commit -m "feat(usage): record every model and embedding call to the ledger"
```

---

### Task 9: Cost admin view and retention sweep

**Files:**
- Create: `src/app/api/admin/costs/route.ts`
- Create: `src/app/admin/costs/page.tsx`
- Modify: the retention cron route (find it with `grep -rn "retention" src/app/api/cron`)

**Interfaces:**
- Consumes: `LlmCall` model (Task 7)
- Produces: `GET /api/admin/costs?days=<n>`

- [ ] **Step 1: Write the API route**

Create `src/app/api/admin/costs/route.ts`:

```ts
import { systemPrisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

// Internal ops visibility only — never exposed to customer org admins.
export const GET = withAuthenticatedApi(async (request) => {
  const days = Math.min(90, Math.max(1, Number(request.nextUrl.searchParams.get('days')) || 30))
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const byOrg = await systemPrisma.llmCall.groupBy({
    by: ['organizationId'],
    where: { createdAt: { gte: since } },
    _sum: { costUsd: true, inputTokens: true, cacheReadTokens: true, outputTokens: true },
    orderBy: { _sum: { costUsd: 'desc' } },
    take: 50,
  })

  const bySurface = await systemPrisma.llmCall.groupBy({
    by: ['surface'],
    where: { createdAt: { gte: since } },
    _sum: { costUsd: true },
    _count: true,
  })

  const byModel = await systemPrisma.llmCall.groupBy({
    by: ['provider', 'model', 'priceVersion'],
    where: { createdAt: { gte: since } },
    _sum: { costUsd: true },
    _count: true,
    orderBy: { _sum: { costUsd: 'desc' } },
    take: 50,
  })

  const organizations = await systemPrisma.organization.findMany({
    where: { id: { in: byOrg.map((row) => row.organizationId) } },
    select: { id: true, name: true },
  })
  const nameById = new Map(organizations.map((org) => [org.id, org.name]))

  return {
    success: true,
    days,
    byOrg: byOrg.map((row) => ({
      organizationId: row.organizationId,
      name: nameById.get(row.organizationId) ?? 'unknown',
      costUsd: Number(row._sum.costUsd ?? 0),
      inputTokens: row._sum.inputTokens ?? 0,
      cacheReadTokens: row._sum.cacheReadTokens ?? 0,
      outputTokens: row._sum.outputTokens ?? 0,
    })),
    bySurface: bySurface.map((row) => ({
      surface: row.surface,
      costUsd: Number(row._sum.costUsd ?? 0),
      calls: row._count,
    })),
    byModel: byModel.map((row) => ({
      provider: row.provider,
      model: row.model,
      priceVersion: row.priceVersion,
      costUsd: Number(row._sum.costUsd ?? 0),
      calls: row._count,
    })),
  }
}, { permission: 'catalogue.review' })
```

- [ ] **Step 2: Write the admin page**

Create `src/app/admin/costs/page.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'

type Report = {
  days: number
  byOrg: { organizationId: string; name: string; costUsd: number; inputTokens: number; cacheReadTokens: number; outputTokens: number }[]
  bySurface: { surface: string; costUsd: number; calls: number }[]
  byModel: { provider: string; model: string; priceVersion: string; costUsd: number; calls: number }[]
}

const usd = (value: number) => `$${value.toFixed(2)}`

export default function CostsPage() {
  const [report, setReport] = useState<Report | null>(null)
  const [days, setDays] = useState(30)

  useEffect(() => {
    void (async () => {
      const response = await fetch(`/api/admin/costs?days=${days}`, { cache: 'no-store' })
      if (response.ok) setReport(await response.json())
    })()
  }, [days])

  const unknownPricing = report?.byModel.filter((row) => row.priceVersion === 'unknown') ?? []

  return (
    <div className="space-y-8">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Model spend</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Internal estimate from the price table — not reconciled against provider invoices.
          </p>
        </div>
        <select
          value={days}
          onChange={(event) => setDays(Number(event.target.value))}
          className="rounded-md border px-3 py-2 text-sm"
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </header>

      {unknownPricing.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <p className="font-medium">Some calls have no price.</p>
          <p className="mt-1 text-muted-foreground">
            {unknownPricing.map((row) => `${row.provider}:${row.model}`).join(', ')} — add rates to
            src/lib/usage/pricing.ts. Their cost currently counts as zero.
          </p>
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium">By workspace</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-2">Workspace</th>
                <th>Cost</th>
                <th>Input</th>
                <th>Cache reads</th>
                <th>Output</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {report?.byOrg.map((row) => (
                <tr key={row.organizationId}>
                  <td className="py-2">{row.name}</td>
                  <td>{usd(row.costUsd)}</td>
                  <td>{row.inputTokens.toLocaleString()}</td>
                  <td>{row.cacheReadTokens.toLocaleString()}</td>
                  <td>{row.outputTokens.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-2">
          <h2 className="text-sm font-medium">By surface</h2>
          <ul className="divide-y rounded-lg border text-sm">
            {report?.bySurface.map((row) => (
              <li key={row.surface} className="flex justify-between px-4 py-2">
                <span>{row.surface.replace(/_/g, ' ')}</span>
                <span className="text-muted-foreground">
                  {usd(row.costUsd)} · {row.calls.toLocaleString()} calls
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="space-y-2">
          <h2 className="text-sm font-medium">By model</h2>
          <ul className="divide-y rounded-lg border text-sm">
            {report?.byModel.map((row) => (
              <li key={`${row.provider}:${row.model}`} className="flex justify-between px-4 py-2">
                <span>{row.model}</span>
                <span className="text-muted-foreground">
                  {usd(row.costUsd)} · {row.calls.toLocaleString()} calls
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  )
}
```

- [ ] **Step 3: Add the retention sweep**

Locate the retention cron:

```bash
grep -rn "retention" src/app/api/cron --include="*.ts" | head
```

In that route's handler, add alongside the existing sweeps:

```ts
  // LlmCall detail ages out at 90 days; the denormalized totals on
  // AgentExecution/FlowRun survive, so historical run cost stays visible.
  const llmCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
  const llmCalls = await systemPrisma.llmCall.deleteMany({ where: { createdAt: { lt: llmCutoff } } })
```

and include `llmCalls: llmCalls.count` in the route's response summary, matching how the sibling sweeps report their counts.

- [ ] **Step 4: Run the full local gate**

```bash
npm run typecheck && npm run lint && npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/app/api/admin/costs src/app/admin/costs src/app/api/cron
git commit -m "feat(admin): model spend view and 90-day ledger retention"
```

---

# WORKSTREAM D — Fork State Overrides

Independent of A/B/C.

---

### Task 10: Override key resolution

**Files:**
- Create: `src/lib/flows/state-overrides.ts`
- Test: `src/lib/flows/__tests__/state-overrides.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `StateOverrides` type (`Record<string, unknown>`); `parseStateOverrides(value: unknown): StateOverrides | null`; `resolveOverride(overrides: StateOverrides | null, iterationKey: string): { hit: boolean; value: unknown }`

- [ ] **Step 1: Write the failing test**

Create `src/lib/flows/__tests__/state-overrides.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseStateOverrides, resolveOverride } from '@/lib/flows/state-overrides'

test('an exact iteration key wins over the bare node key', () => {
  const overrides = { 'fetch': 'all-iterations', 'fetch#2': 'just-two' }
  assert.deepEqual(resolveOverride(overrides, 'fetch#2'), { hit: true, value: 'just-two' })
})

test('a bare node key applies to every iteration of that node', () => {
  const overrides = { fetch: 'all-iterations' }
  assert.deepEqual(resolveOverride(overrides, 'fetch#0'), { hit: true, value: 'all-iterations' })
  assert.deepEqual(resolveOverride(overrides, 'fetch#7'), { hit: true, value: 'all-iterations' })
  assert.deepEqual(resolveOverride(overrides, 'fetch'), { hit: true, value: 'all-iterations' })
})

test('an unrelated node is not overridden', () => {
  assert.deepEqual(resolveOverride({ fetch: 1 }, 'transform'), { hit: false, value: undefined })
  assert.deepEqual(resolveOverride({ fetch: 1 }, 'fetcher'), { hit: false, value: undefined })
})

test('a null override is a hit, not a miss', () => {
  // Distinguishing "override this to null" from "no override" matters: a step
  // legitimately yielding null must be expressible.
  assert.deepEqual(resolveOverride({ fetch: null }, 'fetch'), { hit: true, value: null })
})

test('resolveOverride tolerates no overrides at all', () => {
  assert.deepEqual(resolveOverride(null, 'fetch'), { hit: false, value: undefined })
})

test('parseStateOverrides accepts a plain object and rejects everything else', () => {
  assert.deepEqual(parseStateOverrides({ fetch: 1 }), { fetch: 1 })
  assert.equal(parseStateOverrides(null), null)
  assert.equal(parseStateOverrides([1, 2]), null)
  assert.equal(parseStateOverrides('nope'), null)
  assert.equal(parseStateOverrides({}), null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/state-overrides.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/flows/state-overrides.ts`:

```ts
/**
 * Per-run state overrides: "pretend this step produced THIS instead".
 *
 * Distinct from graph.pinData, which lives on the flow DRAFT and is therefore
 * shared by every run. Overrides live on the FlowRun row, so forking a run to
 * test a hypothesis never mutates the flow everyone else is editing.
 *
 * Precedence at execution time: stateOverrides > pinData > replayed output.
 */

export type StateOverrides = Record<string, unknown>

/** Narrow persisted JSON to a usable override map. Empty means "none". */
export function parseStateOverrides(value: unknown): StateOverrides | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>)
  return entries.length ? (Object.fromEntries(entries) as StateOverrides) : null
}

/**
 * Resolve one node's override. `iterationKey` is either a bare node id or the
 * per-iteration `${nodeId}#${index}` form used inside loops.
 *
 * An exact `node#i` entry applies to that iteration only; a bare `node` entry
 * applies to every iteration. The more specific key wins.
 *
 * Returns `hit` separately from `value` so that overriding a step to `null` is
 * expressible and distinct from "not overridden".
 */
export function resolveOverride(
  overrides: StateOverrides | null,
  iterationKey: string,
): { hit: boolean; value: unknown } {
  if (!overrides) return { hit: false, value: undefined }

  if (Object.prototype.hasOwnProperty.call(overrides, iterationKey)) {
    return { hit: true, value: overrides[iterationKey] }
  }

  const bare = iterationKey.split('#')[0]
  if (Object.prototype.hasOwnProperty.call(overrides, bare)) {
    return { hit: true, value: overrides[bare] }
  }

  return { hit: false, value: undefined }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/state-overrides.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/state-overrides.ts src/lib/flows/__tests__/state-overrides.test.ts
git commit -m "feat(flows): per-run state override key resolution"
```

---

### Task 11: Apply overrides in the interpreter

**Files:**
- Modify: `prisma/schema.prisma` — `FlowRun.stateOverrides`
- Modify: `src/features/flows/execute-flow.ts` — job type, override application, patch-resume
- Test: `src/features/flows/__tests__/state-overrides.db.test.ts`

**Interfaces:**
- Consumes: `parseStateOverrides`, `resolveOverride` (Task 10)
- Produces: `FlowExecutionJob` gains `overrides?: Record<string, unknown>` and `resumeFrom?: { nodeId: string }`

- [ ] **Step 1: Add the column**

In `prisma/schema.prisma`, add to `FlowRun`:

```prisma
  /// Per-run "pretend this step produced X" map, set when forking a run or
  /// patching a failed one. Distinct from graph.pinData, which lives on the
  /// shared flow draft. Precedence: stateOverrides > pinData > replayed output.
  stateOverrides    Json?
```

- [ ] **Step 2: Generate the migration**

```bash
npx prisma migrate dev --name flow_run_state_overrides
```

- [ ] **Step 3: Write the failing test**

Create `src/features/flows/__tests__/state-overrides.db.test.ts`:

```ts
import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let flowSideEffectKey: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ flowSideEffectKey } = await import('@/lib/flows/idempotency'))

    const stamp = Date.now()
    const org = await prisma.organization.create({ data: { name: 'Fork', slug: `fork-${stamp}` } })
    ids.org = org.id
    const user = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), email: `fork-${stamp}@example.com`, name: 'F', organizationId: org.id },
    })
    ids.user = user.id
    const flow = await prisma.flow.create({
      data: { name: 'Fork flow', organizationId: org.id, userId: user.id, graph: { nodes: [], edges: [] } },
    })
    ids.flow = flow.id

    const run = await prisma.flowRun.create({
      data: { flowId: flow.id, organizationId: org.id, userId: user.id, status: 'failed', input: {} },
    })
    ids.run = run.id
    await prisma.flowRunStep.create({
      data: { flowRunId: run.id, nodeId: 'fetch', order: 0, status: 'succeeded', output: { value: 'original' } },
    })
    await prisma.flowRunStep.create({
      data: { flowRunId: run.id, nodeId: 'transform', order: 1, status: 'failed', error: 'boom' },
    })
  })

  test('stateOverrides round-trips as JSON on the run row', async () => {
    await prisma.flowRun.update({
      where: { id: ids.run },
      data: { stateOverrides: { fetch: { value: 'patched' } } },
    })
    const run = await prisma.flowRun.findUnique({ where: { id: ids.run } })
    assert.deepEqual(run.stateOverrides, { fetch: { value: 'patched' } })
  })

  test('a fork gets different idempotency keys than its source run', () => {
    const source = flowSideEffectKey(ids.run, 'send-email', 0)
    const forked = flowSideEffectKey('different-run-id', 'send-email', 0)
    assert.notEqual(source, forked)
  })

  test('a patch-resume on the same run keeps identical idempotency keys', () => {
    const before = flowSideEffectKey(ids.run, 'send-email', 0)
    const after = flowSideEffectKey(ids.run, 'send-email', 0)
    assert.equal(before, after, 'replayed steps must not re-fire external writes')
  })

  test('the original failed step row survives a patch-resume append', async () => {
    const maxOrder = await prisma.flowRunStep.aggregate({
      where: { flowRunId: ids.run },
      _max: { order: true },
    })
    await prisma.flowRunStep.create({
      data: {
        flowRunId: ids.run,
        nodeId: 'transform',
        order: (maxOrder._max.order ?? 0) + 1,
        status: 'succeeded',
        output: { value: 'retried' },
      },
    })

    const rows = await prisma.flowRunStep.findMany({
      where: { flowRunId: ids.run, nodeId: 'transform' },
      orderBy: { order: 'asc' },
    })
    assert.equal(rows.length, 2)
    assert.equal(rows[0].status, 'failed', 'original failure must remain as evidence')
    assert.equal(rows[1].status, 'succeeded')
  })
}
```

- [ ] **Step 4: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://postgres:ci@localhost:5432/ci_repro TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/flows/__tests__/state-overrides.db.test.ts`
Expected: FAIL — `stateOverrides` is not a known field (if the migration has not been applied to the test DB, run `npx prisma migrate deploy` against it first).

- [ ] **Step 5: Extend the job type**

In `src/features/flows/execute-flow.ts`, add to `FlowExecutionJob`:

```ts
  /**
   * "Pretend this step produced X." Keyed by node id or `node#i` iteration key.
   * Applied after replay seeding and after pinData, so an override is the most
   * specific intent and wins. Persisted on the run for provenance.
   */
  overrides?: Record<string, unknown>
  /**
   * Patch-and-resume: reopen an existing FAILED run and re-execute from
   * `nodeId` on the SAME run row. Unlike replayFrom (which forks to a new run),
   * this keeps the run id — and therefore its idempotency keys, so replayed
   * steps do not re-fire external writes.
   */
  resumeFrom?: { nodeId: string }
```

- [ ] **Step 6: Apply overrides after the pin block**

In `src/features/flows/execute-flow.ts`, immediately after the `if (graph.pinData) { ... }` block (currently around line 525), add:

```ts
  // Per-run overrides beat both pins and replayed outputs: they are the most
  // specific intent expressed, scoped to THIS run, and never touch the shared
  // flow draft the way pinData does.
  const overrides = parseStateOverrides(run.stateOverrides)
  if (overrides) {
    for (const nodeId of nodeById.keys()) {
      const { hit, value } = resolveOverride(overrides, nodeId)
      if (hit) completed[nodeId] = value
    }
    // Iteration-specific keys name rows that may not exist as bare nodes.
    for (const key of Object.keys(overrides)) {
      if (key.includes('#') && nodeById.has(key.split('#')[0])) completed[key] = overrides[key]
    }
  }
```

Add the import:

```ts
import { parseStateOverrides, resolveOverride } from '@/lib/flows/state-overrides'
```

- [ ] **Step 7: Persist overrides on run creation and handle patch-resume**

In `createFlowRunRow`, add `stateOverrides` to the created data:

```ts
      stateOverrides: job.overrides && Object.keys(job.overrides).length ? jsonValue(job.overrides) : undefined,
```

In `loadReplaySource`, add a sibling guard for patch-resume. After the existing `replayFrom` handling, add a new function:

```ts
/**
 * Reopen a FAILED run for patch-and-resume. Refuses anything else: rewriting a
 * succeeded run corrupts the record, and running/waiting runs are already owned
 * by the existing resume path.
 */
async function reopenForPatch(job: FlowExecutionJob): Promise<void> {
  if (!job.resumeFrom || !job.flowRunId) return
  const run = await prisma.flowRun.findFirst({
    where: { id: job.flowRunId, flowId: job.flowId, organizationId: job.organizationId },
  })
  if (!run) throw new ApiError('That run no longer exists.', 404, 'NOT_FOUND')
  if (run.status !== 'failed') {
    throw new ApiError(
      'Only a failed run can be patched and resumed. Fork it to a new run instead.',
      409,
      'FLOW_PATCH_NOT_FAILED',
    )
  }
  await prisma.flowRun.update({
    where: { id: run.id },
    data: {
      status: 'running',
      error: null,
      finishedAt: null,
      ...(job.overrides && Object.keys(job.overrides).length ? { stateOverrides: jsonValue(job.overrides) } : {}),
    },
  })
}
```

Call it at the top of `runFlowExecution`, before `loadReplaySource`.

- [ ] **Step 8: Seed from the latest generation below the cutoff**

Where the replay block seeds `completed` from prior steps, the same loop must run for a patch-resume against the run's OWN steps. Because re-execution appends rows with higher `order`, seeding must take the LATEST row per node id below the cutoff. Replace the seeding loop body with:

```ts
    // Latest generation wins: a patch-resume appends new rows rather than
    // deleting old ones, so the same nodeId can appear more than once. Rows are
    // ordered ascending, so a later assignment naturally supersedes an earlier.
    for (const step of priorSteps) {
      if (step.order >= cutoff) continue
      if (step.status === 'succeeded' || step.status === 'skipped') completed[step.nodeId] = step.output
      if (step.status === 'failed') {
        const baseNode = nodeById.get(step.nodeId.split('#')[0])
        const onError = baseNode && 'onError' in baseNode.data ? (baseNode.data as { onError?: string }).onError : undefined
        if ((onError === 'route' || onError === 'continue') && step.output !== null && step.output !== undefined) {
          completed[step.nodeId] = step.output
          if (onError === 'route') completedRoutes.add(step.nodeId)
        }
      }
    }
```

(The loop body is unchanged from the existing code — the ascending order already gives latest-wins. Confirm `orderBy: { order: 'asc' }` is present on the `priorSteps` query; it is.)

For the patch-resume path, set `order` for new rows to continue from the current max rather than restarting:

```ts
  if (job.resumeFrom && job.flowRunId) {
    const priorSteps = await prisma.flowRunStep.findMany({
      where: { flowRunId: job.flowRunId },
      orderBy: { order: 'asc' },
    })
    const target = job.resumeFrom.nodeId
    const firstTargetRow = priorSteps.find((step) => step.nodeId === target || step.nodeId.startsWith(`${target}#`))
    const cutoff = firstTargetRow ? firstTargetRow.order : Number.POSITIVE_INFINITY
    for (const step of priorSteps) {
      if (step.order >= cutoff) continue
      if (step.status === 'succeeded' || step.status === 'skipped') completed[step.nodeId] = step.output
    }
    // Append rather than overwrite: the failed row stays as evidence.
    order = Math.max(...priorSteps.map((step) => step.order), -1) + 1
  }
```

- [ ] **Step 9: Run test to verify it passes**

Run: `TEST_DATABASE_URL=postgresql://postgres:ci@localhost:5432/ci_repro TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/flows/__tests__/state-overrides.db.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 10: Run the full local gate**

```bash
npm run typecheck && npm run lint && npm test
```
Expected: all pass, including the existing `execute-flow-resume.test.ts` and `execute-flow-start.test.ts`.

- [ ] **Step 11: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/features/flows/execute-flow.ts src/features/flows/__tests__/state-overrides.db.test.ts
git commit -m "feat(flows): per-run state overrides and patch-resume for failed runs"
```

---

### Task 12: Route and UI for forking with edits

**Files:**
- Modify: `src/app/api/flows/[id]/execute/route.ts:117`
- Modify: `src/components/flows/run-panel.tsx`
- Modify: `src/app/flows/[id]/page.tsx` (around `rerunFromStep`, line ~1503)

**Interfaces:**
- Consumes: `overrides`, `resumeFrom` on `FlowExecutionJob` (Task 11)
- Produces: request body accepts `overrides?: Record<string, unknown>` and `mode?: 'fork' | 'patch'`

- [ ] **Step 1: Accept overrides in the execute route**

In `src/app/api/flows/[id]/execute/route.ts`, add to the request zod schema:

```ts
  overrides: z.record(z.string(), z.unknown()).optional(),
  mode: z.enum(['fork', 'patch']).optional(),
```

and replace the job construction at line 117:

```ts
    // 'patch' reopens the SAME run (keeping its idempotency keys, so replayed
    // steps do not re-fire external writes). 'fork' — the default — starts a
    // new run, which necessarily gets fresh keys.
    ...(parsed.mode === 'patch' && parsed.fromRunId && parsed.fromNodeId
      ? { flowRunId: parsed.fromRunId, resumeFrom: { nodeId: parsed.fromNodeId } }
      : {
          replayFrom:
            parsed.fromRunId && parsed.fromNodeId
              ? { runId: parsed.fromRunId, nodeId: parsed.fromNodeId }
              : undefined,
        }),
    overrides: parsed.overrides,
```

- [ ] **Step 2: Record the audit event**

In the same route, after dispatch succeeds, add:

```ts
  if (parsed.overrides && Object.keys(parsed.overrides).length) {
    await recordAudit({
      organizationId: auth.organizationId,
      action: 'flow.run_overridden',
      actorUserId: auth.dbUser.id,
      resourceType: 'flow',
      resourceId: flowId,
      detail: { mode: parsed.mode ?? 'fork', nodes: Object.keys(parsed.overrides), fromRunId: parsed.fromRunId },
    })
  }
```

Add `import { recordAudit } from '@/lib/audit'`. Use the route's existing identifiers for `auth` and the flow id.

- [ ] **Step 3: Add the fork-with-edits control**

In `src/components/flows/run-panel.tsx`, extend `StepRow`'s props and add a second button beside the existing "Re-run from here":

```tsx
                {onForkWithEdits && (
                  <button
                    type="button"
                    onClick={onForkWithEdits}
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    title="Start a run with this step's result replaced by a value you choose"
                  >
                    <Pencil className="h-3 w-3" /> Fork with edits
                  </button>
                )}
```

Add `Pencil` to the existing `lucide-react` import, add `onForkWithEdits?: () => void` to `StepRow`'s props, and thread it from the parent exactly as `onRerunFrom` is threaded (props at lines ~317-325, call site at ~372-374).

- [ ] **Step 4: Add the editor and dispatch**

In `src/app/flows/[id]/page.tsx`, beside `rerunFromStep`, add:

```tsx
  const forkWithEdits = useCallback(
    async (runId: string, nodeId: string, recordedOutput: unknown, runFailed: boolean) => {
      const edited = window.prompt(
        `Replace what "${nodeId}" produced. Everything after it re-runs with this value.`,
        JSON.stringify(recordedOutput ?? null, null, 2),
      )
      if (edited === null) return

      let value: unknown
      try {
        value = JSON.parse(edited)
      } catch {
        toast.error('That is not valid JSON — check for a missing quote or comma.')
        return
      }

      // A fork is a NEW run, so it gets fresh idempotency keys and any step that
      // writes to an external system will write again. Patching a failed run in
      // place keeps the run id, so replayed steps stay deduped.
      const patch =
        runFailed &&
        window.confirm(
          'Continue this same run from the edited step?\n\n' +
            'OK — resume this run. Steps that already ran will not repeat their external actions.\n' +
            'Cancel — start a separate run instead. Steps that send email, post messages, or write to other systems WILL run again.',
        )

      const response = await fetch(`/api/flows/${flowId}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fromRunId: runId,
          fromNodeId: nodeId,
          mode: patch ? 'patch' : 'fork',
          overrides: { [nodeId]: value },
        }),
      })
      const data = await response.json()
      if (!response.ok) {
        toast.error(data.error || 'Could not start that run.')
        return
      }
      toast.success(patch ? 'Resuming this run from the edited step.' : 'Started a new run with your edit.')
    },
    [flowId],
  )
```

Wire it into the `RunPanel` usage at line ~2416 alongside `onRerunFrom`, passing the selected step's recorded output and whether the selected run's status is `'failed'`.

- [ ] **Step 5: Run the full local gate**

```bash
npm run typecheck && npm run lint && npm test
```

- [ ] **Step 6: Commit**

```bash
git add src/app/api/flows src/components/flows/run-panel.tsx src/app/flows
git commit -m "feat(flows): fork a run with an edited step result"
```

---

# WORKSTREAM E — Nightly Eval Gate

Depends on Workstream C for `eval_judge` spend visibility.

---

### Task 13: Baseline comparison

**Files:**
- Create: `src/lib/eval/baseline.ts`
- Create: `src/lib/eval/baseline.json`
- Test: `src/lib/eval/__tests__/baseline.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `REGRESSION_TOLERANCE = 0.15`, `ABSOLUTE_FLOOR = 0.7`; `type Baseline = Record<string, number>`; `type Scorecard = Record<string, number>`; `compareToBaseline(scorecard: Scorecard, baseline: Baseline): { ok: boolean; failures: string[]; corpusMean: number }`

- [ ] **Step 1: Write the failing test**

Create `src/lib/eval/__tests__/baseline.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { compareToBaseline, REGRESSION_TOLERANCE, ABSOLUTE_FLOOR } from '@/lib/eval/baseline'

test('a scorecard matching its baseline passes', () => {
  const result = compareToBaseline({ a: 0.9, b: 0.85 }, { a: 0.9, b: 0.85 })
  assert.equal(result.ok, true)
  assert.deepEqual(result.failures, [])
})

test('a drop beyond the tolerance fails and names the fixture', () => {
  const result = compareToBaseline({ a: 0.9 - REGRESSION_TOLERANCE - 0.01 }, { a: 0.9 })
  assert.equal(result.ok, false)
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0], /^a\b/)
})

test('a drop within the tolerance passes, since judge scores are noisy', () => {
  const result = compareToBaseline({ a: 0.9 - REGRESSION_TOLERANCE + 0.01 }, { a: 0.9 })
  assert.equal(result.ok, true)
})

test('an improvement never fails', () => {
  const result = compareToBaseline({ a: 1 }, { a: 0.7 })
  assert.equal(result.ok, true)
})

test('the corpus mean must clear the absolute floor even with no baseline drop', () => {
  const low = ABSOLUTE_FLOOR - 0.1
  const result = compareToBaseline({ a: low, b: low }, { a: low, b: low })
  assert.equal(result.ok, false)
  assert.ok(result.failures.some((failure) => /corpus mean/i.test(failure)))
})

test('a fixture with no baseline is reported but does not fail the run', () => {
  const result = compareToBaseline({ a: 0.9, brandNew: 0.95 }, { a: 0.9 })
  assert.equal(result.ok, true)
})

test('corpusMean is the arithmetic mean of the scorecard', () => {
  const result = compareToBaseline({ a: 0.8, b: 1 }, { a: 0.8, b: 1 })
  assert.ok(Math.abs(result.corpusMean - 0.9) < 1e-9)
})

test('an empty scorecard fails rather than vacuously passing', () => {
  const result = compareToBaseline({}, {})
  assert.equal(result.ok, false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/eval/__tests__/baseline.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/eval/baseline.ts`:

```ts
/**
 * Regression gating for judge-scored evals.
 *
 * JudgeResult.score is an LLM-produced float, so a single sample is too noisy
 * to gate on — the nightly runner averages several judgements per fixture and
 * compares the mean here. Two independent conditions must hold: no fixture may
 * fall far below its own history, and the corpus as a whole must clear an
 * absolute quality bar.
 */

export type Baseline = Record<string, number>
export type Scorecard = Record<string, number>

/** How far a fixture may drift below its baseline before it counts as a regression. */
export const REGRESSION_TOLERANCE = 0.15

/** The corpus mean must stay at or above this regardless of baseline drift. */
export const ABSOLUTE_FLOOR = 0.7

export function compareToBaseline(
  scorecard: Scorecard,
  baseline: Baseline,
): { ok: boolean; failures: string[]; corpusMean: number } {
  const names = Object.keys(scorecard)
  const failures: string[] = []

  if (names.length === 0) {
    // An empty scorecard means the run produced nothing — a broken harness must
    // not read as a clean bill of health.
    return { ok: false, failures: ['no fixtures scored — the eval run produced no results'], corpusMean: 0 }
  }

  for (const name of names) {
    const score = scorecard[name]
    const previous = baseline[name]
    // A brand-new fixture has nothing to regress against; it still counts
    // toward the corpus mean below.
    if (previous === undefined) continue
    if (score < previous - REGRESSION_TOLERANCE) {
      failures.push(`${name}: ${score.toFixed(3)} vs baseline ${previous.toFixed(3)} (tolerance ${REGRESSION_TOLERANCE})`)
    }
  }

  const corpusMean = names.reduce((total, name) => total + scorecard[name], 0) / names.length
  if (corpusMean < ABSOLUTE_FLOOR) {
    failures.push(`corpus mean ${corpusMean.toFixed(3)} is below the floor of ${ABSOLUTE_FLOOR}`)
  }

  return { ok: failures.length === 0, failures, corpusMean }
}
```

- [ ] **Step 4: Create the empty baseline**

Create `src/lib/eval/baseline.json`:

```json
{}
```

The first nightly run writes real values into it rather than failing against an empty file.

- [ ] **Step 5: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/eval/__tests__/baseline.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/eval/baseline.ts src/lib/eval/baseline.json src/lib/eval/__tests__/baseline.test.ts
git commit -m "feat(eval): baseline regression comparison with tolerance and absolute floor"
```

---

### Task 14: Nightly runner and capture CLI

**Files:**
- Create: `src/lib/eval/nightly.ts`
- Create: `src/lib/eval/capture.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `compareToBaseline` (Task 13); `runLoop`, `cannedDispatch` from `@/lib/eval/harness`; `judgeTrajectory`; `fixtures`; `fixtureFromTranscript`
- Produces: `npm run eval:nightly`, `npm run eval:capture -- <executionId>`

- [ ] **Step 1: Write the nightly runner**

Create `src/lib/eval/nightly.ts`:

```ts
/**
 * Nightly quality gate. Runs every fixture LIVE against a real model, judges
 * each one several times, and compares the per-fixture means to the committed
 * baseline. Exits non-zero on regression so the workflow can raise an issue.
 *
 * Not a PR gate: it needs a model key and it costs money. Deterministic
 * scripted replay already blocks PRs via `npm test`.
 */
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createModelRunner } from '@/lib/llm/model-runner'
import { runLoop, cannedDispatch, checkTrajectory } from './harness'
import { judgeTrajectory } from './judge'
import { fixtures } from './fixtures'
import { compareToBaseline, type Baseline, type Scorecard } from './baseline'

/** Judgements per fixture. Averaging tames the judge's run-to-run variance. */
const SAMPLES = 3

const BASELINE_PATH = join(process.cwd(), 'src/lib/eval/baseline.json')

async function meanScore(fixtureName: string, rubric: string, trajectory: any): Promise<number> {
  const scores: number[] = []
  for (let i = 0; i < SAMPLES; i += 1) {
    const verdict = await judgeTrajectory(rubric, trajectory)
    scores.push(verdict.score)
  }
  const mean = scores.reduce((total, score) => total + score, 0) / scores.length
  console.log(`  ${fixtureName}: ${scores.map((s) => s.toFixed(2)).join(', ')} → ${mean.toFixed(3)}`)
  return mean
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.QWEN_API_KEY) {
    console.error('No model key configured — set ANTHROPIC_API_KEY or QWEN_API_KEY.')
    process.exit(1)
  }

  const scorecard: Scorecard = {}
  const structural: string[] = []

  for (const fixture of fixtures) {
    if (!fixture.rubric) {
      console.log(`  ${fixture.name}: skipped (no rubric)`)
      continue
    }
    const runner = createModelRunner(fixture.model)
    const trajectory = await runLoop(runner, fixture, cannedDispatch(fixture.toolResponses))

    // Deterministic asserts still apply on a live run — a structural break is a
    // failure regardless of what the judge thinks of the prose.
    const problems = checkTrajectory(trajectory, fixture.expect)
    if (problems.length) structural.push(`${fixture.name}: ${problems.join('; ')}`)

    scorecard[fixture.name] = await meanScore(fixture.name, fixture.rubric, trajectory)
  }

  const baseline: Baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  const isFirstRun = Object.keys(baseline).length === 0

  if (isFirstRun) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(scorecard, null, 2)}\n`)
    console.log('\nNo baseline yet — wrote the current scores as the baseline.')
    console.log('Commit src/lib/eval/baseline.json to start gating.')
    return
  }

  const result = compareToBaseline(scorecard, baseline)
  console.log(`\nCorpus mean: ${result.corpusMean.toFixed(3)}`)

  const allFailures = [...structural, ...result.failures]
  if (allFailures.length) {
    console.error('\nEval regressions:')
    for (const failure of allFailures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log('All fixtures within tolerance.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
```

- [ ] **Step 2: Write the capture CLI**

Create `src/lib/eval/capture.ts`:

```ts
/**
 * Turn a real production run into a committed regression fixture.
 *
 *   npm run eval:capture -- <agentExecutionId>
 *
 * Writes a fixture module under src/lib/eval/fixtures/. Add a rubric, register
 * it in fixtures/index.ts, and commit — the failure can never silently return.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { systemPrisma } from '@/lib/prisma'
import { fixtureFromTranscript } from './from-transcript'

async function main() {
  const executionId = process.argv[2]
  if (!executionId) {
    console.error('Usage: npm run eval:capture -- <agentExecutionId>')
    process.exit(1)
  }

  const execution = await systemPrisma.agentExecution.findUnique({
    where: { id: executionId },
    select: { id: true, transcript: true, input: true, agentType: true },
  })
  if (!execution) {
    console.error(`No execution ${executionId}.`)
    process.exit(1)
  }
  if (!Array.isArray(execution.transcript)) {
    console.error('That execution has no transcript to replay.')
    process.exit(1)
  }

  const name = `captured-${execution.id.slice(-8)}`
  const fixture = fixtureFromTranscript({
    name,
    // The live system prompt is assembled per run and not persisted verbatim;
    // the operator pastes the real one in before committing.
    system: 'REPLACE ME: paste the system prompt this run used.',
    transcript: execution.transcript as unknown[],
    rubric: 'REPLACE ME: what must a correct run of this scenario do?',
  })

  const path = join(process.cwd(), 'src/lib/eval/fixtures', `${name}.ts`)
  writeFileSync(
    path,
    `import type { EvalFixture } from '../types'\n\n` +
      `export const ${name.replace(/-/g, '_')}: EvalFixture = ${JSON.stringify(fixture, null, 2)}\n`,
  )

  console.log(`Wrote ${path}`)
  console.log('Next: replace the system prompt and rubric, then add it to fixtures/index.ts.')
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => systemPrisma.$disconnect())
```

- [ ] **Step 3: Add the scripts**

In `package.json`, add to `scripts`:

```json
    "eval:nightly": "tsx src/lib/eval/nightly.ts",
    "eval:capture": "tsx src/lib/eval/capture.ts",
```

- [ ] **Step 4: Verify types and lint**

```bash
npm run typecheck && npm run lint && npm test
```
Expected: pass. Do NOT run `eval:nightly` locally unless you intend to spend model tokens.

- [ ] **Step 5: Commit**

```bash
git add src/lib/eval/nightly.ts src/lib/eval/capture.ts package.json
git commit -m "feat(eval): nightly judge runner and production-transcript capture CLI"
```

---

### Task 15: Nightly workflow

**Files:**
- Create: `.github/workflows/eval-nightly.yml`

**Interfaces:**
- Consumes: `npm run eval:nightly`, `npm run eval:rag` (Task 14)
- Produces: a scheduled workflow that opens or updates a GitHub issue on regression

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/eval-nightly.yml`:

```yaml
name: Eval Nightly

# Quality gating for judge-scored evals. These need a live model key and cost
# money per run, so they do NOT block PRs — deterministic scripted replay
# already does that via `npm test` in ci.yml.
permissions:
  contents: read
  issues: write

on:
  schedule:
    - cron: '0 7 * * *'
  workflow_dispatch:

jobs:
  eval:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_PASSWORD: ci
          POSTGRES_DB: test
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      NEXT_PUBLIC_SUPABASE_URL: https://example.supabase.co
      NEXT_PUBLIC_SUPABASE_ANON_KEY: ci-placeholder
      DATABASE_URL: postgresql://postgres:ci@localhost:5432/test
      DIRECT_URL: postgresql://postgres:ci@localhost:5432/test
      ENCRYPTION_KEY: ci-encryption-key
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      VOYAGE_API_KEY: ${{ secrets.VOYAGE_API_KEY }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci --no-audit --no-fund
      - run: npx prisma migrate deploy

      - name: Judge-scored fixtures
        id: judge
        run: npm run eval:nightly 2>&1 | tee eval-output.txt

      - name: RAG benchmark
        if: always()
        run: npm run eval:rag 2>&1 | tee -a eval-output.txt

      - name: Raise or update the regression issue
        if: failure()
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs')
            const output = fs.readFileSync('eval-output.txt', 'utf8').slice(-8000)
            const title = 'Eval regression: nightly quality gate failed'
            const body = [
              `Nightly eval failed on \`${context.sha.slice(0, 7)}\`.`,
              '',
              `[Workflow run](${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId})`,
              '',
              '```',
              output,
              '```',
            ].join('\n')

            // One rolling issue rather than a new one each night.
            const existing = await github.rest.issues.listForRepo({
              owner: context.repo.owner,
              repo: context.repo.repo,
              state: 'open',
              labels: 'eval-regression',
            })

            if (existing.data.length > 0) {
              await github.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: existing.data[0].number,
                body,
              })
            } else {
              await github.rest.issues.create({
                owner: context.repo.owner,
                repo: context.repo.repo,
                title,
                body,
                labels: ['eval-regression'],
              })
            }
```

- [ ] **Step 2: Verify the workflow parses**

```bash
npx --yes js-yaml .github/workflows/eval-nightly.yml > /dev/null && echo "valid yaml"
```
Expected: `valid yaml`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/eval-nightly.yml
git commit -m "ci: nightly judge-scored eval gate with rolling regression issue"
```

- [ ] **Step 4: Post-merge manual steps**

These cannot be done from the repo and must be done by a maintainer:

1. Add `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY` to repository secrets.
2. Create the `eval-regression` label.
3. Trigger the workflow once via `workflow_dispatch` — the first run writes `baseline.json`.
4. Commit the generated `baseline.json`. Gating begins on the next run.

---

## Self-Review

**Spec coverage:**

| Spec section | Task(s) |
|---|---|
| §1 prerequisite four-bucket fix | 5 |
| §1 four capture points | 8 |
| §1 `LlmCall` schema + rollups | 7 |
| §1 pricing, snapshot, unknown-model | 6 |
| §1 best-effort failure | 7 (test 4) |
| §1 90-day retention | 9 (step 3) |
| §1 admin surface | 9 |
| §2 PR gate unchanged | — (deliberate no-op, noted in §2) |
| §2 nightly workflow | 15 |
| §2 3-sample averaging, tolerance 0.15, floor 0.7 | 13, 14 |
| §2 first run writes baseline | 14 (step 1) |
| §2 rolling GitHub issue | 15 |
| §2 capture flywheel | 14 (step 2) |
| §2 `eval_judge` surface | 7 (`LlmSurface`), 8 |
| §3 `stateOverrides` column | 11 |
| §3 precedence + key resolution | 10, 11 |
| §3 fork vs patch-resume | 11, 12 |
| §3 failed-runs-only restriction | 11 (`reopenForPatch`) |
| §3 append-only reopening | 11 (step 8) |
| §3 side-effect asymmetry in UI | 12 (step 4) |
| §3 audit + permission | 12 (step 2); permission via existing route guard |
| §4 `PlatformAllowedDomain` | 2 |
| §4 gate + hardcoded floor | 2, 3 |
| §4 exact match + public-provider blocklist | 1 |
| §4 shared-org provisioning | 3 |
| §4 admin placement + audit | 4 |
| §4 explicit revocation | 4 (PATCH + confirm dialog) |
| §5 migrations, no backfill | 2, 7, 11 |
| §5 test strategy | throughout |
| §5 build order | workstream order A→B→C→D→E |

No gaps.

**Placeholder scan:** The two `REPLACE ME` strings in Task 14's `capture.ts` are intentional runtime output — the generated fixture asks its operator for a system prompt and rubric that only they can supply. They are not plan placeholders. No `TBD`/`TODO` elsewhere.

**Type consistency:** `TokenUsage` (Task 5) is consumed unchanged by `computeCostUsd` (6) and `LlmCallInput` (7). `LlmSurface` values match the `surface` column comment (7), the `LedgerContext.surface` union (8), and the admin grouping (9). `StateOverrides`/`resolveOverride` (10) match their use in `execute-flow.ts` (11). `Baseline`/`Scorecard` (13) match `nightly.ts` (14). `billableTokens` is named identically at all five call sites.

**Known follow-up not covered here:** Task 8 step 5 says to pass ledger context "at the `runner.next(...)` call" in both executors without quoting the surrounding lines, because the local identifier for the run/execution id differs between them. The implementer must read the enclosing scope. This is the one step in the plan requiring judgment rather than transcription.

---

**Plan complete and saved to `docs/superpowers/plans/2026-08-03-run-observability-and-access.md`.**
