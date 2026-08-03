# Customer Edition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `edition` concept to Backstory Studio that gates off the automatic template-generation pipeline and the cross-workspace staff console, then mirror the tree to `Backstory_customers` where a single committed constant selects the customer edition.

**Architecture:** One compile-time constant (`src/lib/edition.config.ts`) selects the edition; `src/lib/edition.ts` wraps it with a non-production env override for tests. Four enforcement layers consume it — an `internalOnly` option on the shared API wrapper, a `notFound()` in the admin layout, an edge check in middleware, and early returns in the generation job entry points. Nothing is deleted, so `git merge upstream/main` in the fork stays clean forever.

**Tech Stack:** Next.js 15 App Router, TypeScript, Prisma/PostgreSQL, BullMQ, `node:test` via `tsx`.

**Spec:** `docs/superpowers/specs/2026-08-03-customer-edition-design.md`

## Global Constraints

- **Default edition is `internal`.** Every gate must be a no-op unless the edition is explicitly `customer`. The current build's behavior must not change.
- **Never fail open.** A missing or malformed configuration must resolve to `internal` only because that is the committed constant's value — never because an env var was absent.
- **Delete nothing.** No files removed, no Prisma models dropped, no migrations, no test deletions. Gating only.
- **`edition.config.ts` is the fork's only permanent diff.** No other file may differ between the two repos except `README.md`. Never import `EDITION` directly outside `edition.ts`.
- **Metering is untouched.** `src/lib/usage/budget.ts`, `src/lib/usage/ai-guard.ts`, and the token caps in `execute-agent.ts` get no edition gate in any task.
- **Usage/spend UI is untouched.** Per the spec's Scope D, the sidebar meter, `/api/usage`, the `/api/snapshot` usage block and the settings Billing section are all left exactly as they are.
- **Test command:** single file — `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <path>`; full suite — `npm test`.
- **Gate before shipping:** `npm run typecheck && npm run lint && npm test`.

---

### Task 1: Edition module

**Files:**
- Create: `src/lib/edition.config.ts`
- Create: `src/lib/edition.ts`
- Test: `src/lib/__tests__/edition.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Edition = 'internal' | 'customer'`; `appEdition(): Edition`; `isCustomerEdition(): boolean`; `isInternalEdition(): boolean`. Every later task imports from `@/lib/edition` — never from `@/lib/edition.config`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/edition.test.ts`:

```ts
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { appEdition, isCustomerEdition, isInternalEdition } from '@/lib/edition'

const original = process.env.APP_EDITION

afterEach(() => {
  if (original === undefined) delete process.env.APP_EDITION
  else process.env.APP_EDITION = original
})

describe('edition', () => {
  test('defaults to the committed constant when no override is set', () => {
    delete process.env.APP_EDITION
    assert.equal(appEdition(), 'internal')
    assert.equal(isInternalEdition(), true)
    assert.equal(isCustomerEdition(), false)
  })

  test('a non-production override selects the customer edition', () => {
    process.env.APP_EDITION = 'customer'
    assert.equal(appEdition(), 'customer')
    assert.equal(isCustomerEdition(), true)
    assert.equal(isInternalEdition(), false)
  })

  test('an unrecognized override is ignored rather than throwing', () => {
    process.env.APP_EDITION = 'nonsense'
    assert.equal(appEdition(), 'internal')
  })

  test('the override is refused in production, so a deploy cannot be flipped by config', () => {
    const priorNodeEnv = process.env.NODE_ENV
    Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', configurable: true })
    process.env.APP_EDITION = 'customer'
    try {
      assert.equal(appEdition(), 'internal')
    } finally {
      Object.defineProperty(process.env, 'NODE_ENV', { value: priorNodeEnv, configurable: true })
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/__tests__/edition.test.ts`
Expected: FAIL — cannot find module `@/lib/edition`.

- [ ] **Step 3: Write the constant**

Create `src/lib/edition.config.ts`:

```ts
import type { Edition } from './edition'

/**
 * THE ONLY FILE THAT DIFFERS BETWEEN Backstory_Studio AND Backstory_customers.
 *
 * Upstream (this repo) is 'internal'. The customer fork sets 'customer' and
 * changes nothing else, so `git merge upstream/main` never conflicts here —
 * upstream never edits this file.
 *
 * This is a committed constant rather than an env var on purpose: an env var
 * can be omitted on a fresh deploy and would FAIL OPEN, silently granting a
 * customer deployment the staff console and the AI generation pipeline. It also
 * works uniformly in all three runtimes (Next server, browser bundle, and the
 * tsx worker), where a NEXT_PUBLIC_ var would need separate handling.
 */
export const EDITION: Edition = 'internal'
```

- [ ] **Step 4: Write the accessor**

Create `src/lib/edition.ts`:

```ts
import { EDITION } from './edition.config'

export type Edition = 'internal' | 'customer'

/**
 * Test-only override. Guarded three ways so it can never relax a real deploy:
 * refused in production, ignored unless it names a known edition, and safe in
 * the browser bundle where `process` may not exist at all.
 */
function envOverride(): Edition | null {
  if (typeof process === 'undefined') return null
  if (process.env.NODE_ENV === 'production') return null
  const value = process.env.APP_EDITION
  return value === 'customer' || value === 'internal' ? value : null
}

/** Resolved per call, not cached, so tests can flip editions in one process. */
export function appEdition(): Edition {
  return envOverride() ?? EDITION
}

export function isCustomerEdition(): boolean {
  return appEdition() === 'customer'
}

export function isInternalEdition(): boolean {
  return appEdition() === 'internal'
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/__tests__/edition.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 6: Commit**

```bash
git add src/lib/edition.config.ts src/lib/edition.ts src/lib/__tests__/edition.test.ts
git commit -m "feat(edition): compile-time edition constant with a test-only override"
```

---

### Task 2: `internalOnly` gate on the API wrapper

**Files:**
- Modify: `src/lib/server/api-handler.ts:64-83`
- Test: `src/lib/server/__tests__/internal-only.test.ts`

**Interfaces:**
- Consumes: `isCustomerEdition()` from Task 1.
- Produces: `withAuthenticatedApi(handler, { internalOnly: true })` → responds 404 with body `{ success: false, error: 'Not found', code: 'NOT_FOUND' }` in the customer edition, before authentication runs.

The gate must run **before** `requireAuthContext`, so a gated route is indistinguishable from a route that does not exist and never advertises the internal surface to a customer tenant.

- [ ] **Step 1: Write the failing test**

Create `src/lib/server/__tests__/internal-only.test.ts`:

```ts
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

afterEach(() => { delete process.env.APP_EDITION })

const request = () => new NextRequest('http://localhost/api/thing', { method: 'GET' })

describe('internalOnly', () => {
  test('404s in the customer edition without invoking the handler', async () => {
    process.env.APP_EDITION = 'customer'
    let invoked = false
    const route = withAuthenticatedApi(async () => { invoked = true; return { success: true } }, { internalOnly: true, permission: null })

    const response = await route(request())

    assert.equal(response.status, 404)
    assert.equal(invoked, false, 'handler must not run')
    assert.deepEqual(await response.json(), { success: false, error: 'Not found', code: 'NOT_FOUND' })
  })

  test('does not 404 in the internal edition', async () => {
    delete process.env.APP_EDITION
    const route = withAuthenticatedApi(async () => ({ success: true }), { internalOnly: true, permission: null })

    const response = await route(request())

    // No test-auth context here, so this is 401 — the point is that it is NOT 404.
    assert.notEqual(response.status, 404)
  })

  test('an ungated route is unaffected in the customer edition', async () => {
    process.env.APP_EDITION = 'customer'
    const route = withAuthenticatedApi(async () => ({ success: true }), { permission: null })

    const response = await route(request())

    assert.notEqual(response.status, 404)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/server/__tests__/internal-only.test.ts`
Expected: FAIL — the first case returns 401, not 404, because the option does not exist yet.

- [ ] **Step 3: Add the import**

In `src/lib/server/api-handler.ts`, alongside the existing imports:

```ts
import { isCustomerEdition } from '@/lib/edition'
```

- [ ] **Step 4: Add the option to the signature**

In the `options?: {...}` object at `src/lib/server/api-handler.ts:64-75`, add:

```ts
    /**
     * Internal-edition surface. In the customer edition the route answers 404
     * as though it did not exist — checked BEFORE auth, so a customer tenant is
     * never told that an internal route is there to be authenticated against.
     */
    internalOnly?: boolean
```

- [ ] **Step 5: Add the gate**

In the returned handler, as the very first statement inside `try {` — above `const auth = await requireAuthContext(options)`:

```ts
      if (options?.internalOnly && isCustomerEdition()) {
        return NextResponse.json({ success: false, error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
      }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/server/__tests__/internal-only.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 7: Commit**

```bash
git add src/lib/server/api-handler.ts src/lib/server/__tests__/internal-only.test.ts
git commit -m "feat(edition): internalOnly option on withAuthenticatedApi"
```

---

### Task 3: Gate the internal-only routes

**Files:**
- Modify: `src/app/api/template-proposals/route.ts:7`
- Modify: `src/app/api/template-proposals/[id]/accept/route.ts:33`
- Modify: `src/app/api/template-proposals/[id]/dismiss/route.ts:7`
- Modify: `src/app/api/catalogue/staff/route.ts:26,41`
- Modify: `src/app/api/catalogue/review/route.ts:8`
- Modify: `src/app/api/catalogue/review/[id]/route.ts:21`
- Modify: `src/app/api/catalogue/entries/route.ts:14`
- Modify: `src/app/api/catalogue/entries/[id]/route.ts:12`
- Test: `src/app/api/__tests__/edition-gates.test.ts`

**Interfaces:**
- Consumes: `internalOnly` from Task 2.
- Produces: `INTERNAL_ONLY_ROUTES` — an exported `string[]` of route paths relative to `src/app/api`, used by Task 9's completeness check. Export it from the test file created here.

Ten handlers across eight files. Each already passes an options object, so this is adding one property to each — do **not** change any existing `permission` value.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/__tests__/edition-gates.test.ts`:

```ts
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

/** Route dirs relative to src/app/api. Task 9's completeness check reads this. */
export const INTERNAL_ONLY_ROUTES = [
  'template-proposals',
  'template-proposals/[id]/accept',
  'template-proposals/[id]/dismiss',
  'catalogue/staff',
  'catalogue/review',
  'catalogue/review/[id]',
  'catalogue/entries',
  'catalogue/entries/[id]',
]

const cases: Array<{ name: string; load: () => Promise<Record<string, unknown>>; methods: string[] }> = [
  { name: 'template-proposals', load: () => import('../template-proposals/route'), methods: ['GET'] },
  { name: 'template-proposals/[id]/accept', load: () => import('../template-proposals/[id]/accept/route'), methods: ['POST'] },
  { name: 'template-proposals/[id]/dismiss', load: () => import('../template-proposals/[id]/dismiss/route'), methods: ['POST'] },
  { name: 'catalogue/staff', load: () => import('../catalogue/staff/route'), methods: ['GET', 'PATCH'] },
  { name: 'catalogue/review', load: () => import('../catalogue/review/route'), methods: ['GET'] },
  { name: 'catalogue/review/[id]', load: () => import('../catalogue/review/[id]/route'), methods: ['POST'] },
  { name: 'catalogue/entries', load: () => import('../catalogue/entries/route'), methods: ['GET'] },
  { name: 'catalogue/entries/[id]', load: () => import('../catalogue/entries/[id]/route'), methods: ['DELETE'] },
]

afterEach(() => { delete process.env.APP_EDITION })

describe('customer edition route gates', () => {
  for (const routeCase of cases) {
    for (const method of routeCase.methods) {
      test(`${method} /api/${routeCase.name} 404s in the customer edition`, async () => {
        process.env.APP_EDITION = 'customer'
        const mod = await routeCase.load()
        const handler = mod[method] as (r: NextRequest, c?: unknown) => Promise<Response>
        assert.equal(typeof handler, 'function', `${method} is not exported`)

        const response = await handler(
          new NextRequest(`http://localhost/api/${routeCase.name}`, { method, ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }) }),
          { params: Promise.resolve({ id: 'x' }) },
        )

        assert.equal(response.status, 404)
      })
    }
  }

  test('an ungated route still answers in the customer edition', async () => {
    process.env.APP_EDITION = 'customer'
    const mod = await import('../agent-templates/route')
    const handler = mod.GET as (r: NextRequest) => Promise<Response>

    const response = await handler(new NextRequest('http://localhost/api/agent-templates', { method: 'GET' }))

    assert.notEqual(response.status, 404, 'the gate must be selective, not blanket')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/edition-gates.test.ts`
Expected: FAIL — the gated cases return 401/403, not 404.

- [ ] **Step 3: Add `internalOnly: true` to each of the ten handlers**

Each call already ends with an options object. Add the property to each; the existing `permission` stays untouched. For example, in `src/app/api/catalogue/staff/route.ts` both handlers change from:

```ts
}, { permission: 'catalogue.review' })
```

to:

```ts
}, { permission: 'catalogue.review', internalOnly: true })
```

Apply the same edit at every location listed under **Files** above. `src/app/api/template-proposals/route.ts` and the two `[id]` proposal routes carry their own permissions — read each one and add the property without altering what is already there.

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/edition-gates.test.ts`
Expected: PASS, 11/11.

- [ ] **Step 5: Verify the internal edition is unchanged**

Run: `npm test`
Expected: PASS. `route-smoke.test.ts` already skips `catalogue/review`, `catalogue/entries` and `catalogue/staff` (its smoke org is a customer workspace that correctly 403s), and CI runs the internal edition, so no existing case changes.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/template-proposals src/app/api/catalogue src/app/api/__tests__/edition-gates.test.ts
git commit -m "feat(edition): gate proposal + staff catalogue routes to the internal edition"
```

---

### Task 4: Generation entry points become no-ops

**Files:**
- Modify: `src/lib/templates/generation-queue.ts:158-174`
- Modify: `src/lib/workers/runtime.ts:22-31`
- Test: `src/lib/templates/__tests__/generation-edition.test.ts`

**Interfaces:**
- Consumes: `isCustomerEdition()` from Task 1.
- Produces: no signature changes. `maybeGenerateOnGateClear` keeps returning `{ dispatched: boolean; reason: 'gate' | 'debounce' | 'dispatched' }`; `sweepTemplateGeneration` keeps returning `string[]`.

The guards go **inside** these two exported functions, not at their call sites, so a future third caller inherits them automatically. `src/app/api/cron/dispatch/route.ts` and the two Nango routes therefore need no edit at all — the sweep returns `[]` and `generatedOrgs` stays an empty array, keeping the cron response contract edition-independent.

- [ ] **Step 1: Write the failing test**

Create `src/lib/templates/__tests__/generation-edition.test.ts`:

```ts
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { maybeGenerateOnGateClear, sweepTemplateGeneration } from '@/lib/templates/generation-queue'

afterEach(() => { delete process.env.APP_EDITION })

describe('generation is inert in the customer edition', () => {
  test('maybeGenerateOnGateClear dispatches nothing', async () => {
    process.env.APP_EDITION = 'customer'
    // No DB is touched: the edition guard returns before any query, so this
    // passes without a TEST_DATABASE_URL. That is the assertion.
    const result = await maybeGenerateOnGateClear('org-that-does-not-exist')
    assert.deepEqual(result, { dispatched: false, reason: 'gate' })
  })

  test('sweepTemplateGeneration returns no orgs', async () => {
    process.env.APP_EDITION = 'customer'
    const result = await sweepTemplateGeneration(new Date('2026-08-03T00:00:00Z'))
    assert.deepEqual(result, [])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/templates/__tests__/generation-edition.test.ts`
Expected: FAIL — both functions reach Prisma and throw (or hang on a missing database) instead of returning early.

- [ ] **Step 3: Guard both entry points**

In `src/lib/templates/generation-queue.ts`, add the import:

```ts
import { isCustomerEdition } from '@/lib/edition'
```

Then make the first statement of `maybeGenerateOnGateClear`:

```ts
  // The customer edition has no AI template generation. Guarded here rather
  // than at the call sites so any future caller inherits it.
  if (isCustomerEdition()) return { dispatched: false, reason: 'gate' }
```

and the first statement of `sweepTemplateGeneration`:

```ts
  if (isCustomerEdition()) return []
```

- [ ] **Step 4: Skip the worker queue registration**

In `src/lib/workers/runtime.ts`, the `workerSpecs` array currently ends with the `TEMPLATE_GENERATION` entry. Add the import:

```ts
import { isCustomerEdition } from '@/lib/edition'
```

Change the array initializer so the generation spec is included only in the internal edition. Replace the single `TEMPLATE_GENERATION` element with a spread:

```ts
    // Gated AI template generation: its own queue + dead-letter target. The
    // dead-letter terminalizes nothing (generation is additive) — see
    // template-generation-dead-letter.ts. Absent entirely in the customer
    // edition, which never enqueues this job.
    ...(isCustomerEdition()
      ? []
      : [{
          queue: QUEUE_NAMES.TEMPLATE_GENERATION,
          handler: executeTemplateGenerationJob as Processor<any, any, string>,
          onFailed: deadLetterFromTemplateGenerationJob(QUEUE_NAMES.TEMPLATE_GENERATION),
        }]),
```

Leave the imports of `executeTemplateGenerationJob` and `deadLetterFromTemplateGenerationJob` in place — they are still referenced, and removing them would widen the fork's diff.

- [ ] **Step 5: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/templates/__tests__/generation-edition.test.ts`
Expected: PASS, 2/2.

- [ ] **Step 6: Verify existing generation tests still pass**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test $(find src/lib/templates -name '*.test.ts' -path '*__tests__*')`
Expected: PASS — the internal edition is the default, so every existing case is unaffected.

- [ ] **Step 7: Commit**

```bash
git add src/lib/templates/generation-queue.ts src/lib/workers/runtime.ts src/lib/templates/__tests__/generation-edition.test.ts
git commit -m "feat(edition): generation entry points and worker queue inert for customers"
```

---

### Task 5: Inert `ProposalsProvider`

**Files:**
- Modify: `src/components/providers/proposals-provider.tsx:31-55`
- Test: none (see note)

**Interfaces:**
- Consumes: `isCustomerEdition()` from Task 1.
- Produces: no signature change. `useProposals()` keeps returning the same `ProposalsContextValue` shape; in the customer edition `proposals` is always `[]` and `loaded` is `true`.

**This is the only client-side edit in the whole plan.** Every consumer already guards on emptiness — `RecommendationsBar` opens with `if (!proposals.length) return null`, and the notification bell renders its section under `{proposals.length > 0 && ...}` with a badge of `unread + proposals.length`. So an inert provider cascades correctly and neither file needs touching.

No test: the repo has no React component-test harness (`ARCHITECTURE.md` records this as deferred tech debt — all tests are `.test.ts` logic tests). The behavior is verified by the manual check in Step 3 and by Task 8's onboarding test.

- [ ] **Step 1: Add the import**

In `src/components/providers/proposals-provider.tsx`:

```ts
import { isCustomerEdition } from '@/lib/edition'
```

- [ ] **Step 2: Guard the fetch effect**

The effect at line 39 begins `if (!user) { ... return }`. Add an edition guard as the first statement of the effect body, above the `!user` check:

```ts
    // The customer edition has no AI proposals. The provider stays MOUNTED and
    // simply never fetches — removing it would make every useProposals()
    // consumer throw. Consumers already render nothing for an empty array.
    if (isCustomerEdition()) {
      setLoaded(true)
      return
    }
```

Add `isCustomerEdition()` to nothing else — `accept`, `dismiss` and `openDetail` are unreachable with an empty list.

- [ ] **Step 3: Verify no network call is made**

Run: `npm run dev`, then open the app with the customer edition active in a scratch shell:

```bash
APP_EDITION=customer npm run dev
```

Open `/agents` in a browser with devtools' Network tab filtered to `template-proposals`. Expected: **zero** requests, no Recommendations bar, and the notification bell showing only real notifications.

If local Supabase vars are absent this page will 500 by design (see the `local-env-no-supabase` constraint) — in that case skip to Step 4 and rely on Task 8's test plus the CI build.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add src/components/providers/proposals-provider.tsx
git commit -m "feat(edition): inert proposals provider for the customer edition"
```

---

### Task 6: Admin surface returns 404

**Files:**
- Modify: `src/app/admin/layout.tsx`
- Modify: `src/middleware.ts`
- Test: `src/lib/__tests__/edition-middleware.test.ts`

**Interfaces:**
- Consumes: `isCustomerEdition()` from Task 1.
- Produces: `isEditionBlockedPath(pathname: string): boolean` exported from `src/lib/edition.ts` — true when the customer edition must refuse the path outright. Task 9 does not depend on it.

The layout's existing `redirect('/dashboard')` stays for the internal edition (a customer-workspace user without `catalogue.review` still gets redirected). The edition check goes **above** it and uses `notFound()`, because in the customer edition the surface should not exist at all rather than bounce.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/edition-middleware.test.ts`:

```ts
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { isEditionBlockedPath } from '@/lib/edition'

afterEach(() => { delete process.env.APP_EDITION })

describe('isEditionBlockedPath', () => {
  test('blocks the admin surface in the customer edition', () => {
    process.env.APP_EDITION = 'customer'
    assert.equal(isEditionBlockedPath('/admin'), true)
    assert.equal(isEditionBlockedPath('/admin/catalogue'), true)
  })

  test('blocks nothing in the internal edition', () => {
    delete process.env.APP_EDITION
    assert.equal(isEditionBlockedPath('/admin'), false)
    assert.equal(isEditionBlockedPath('/admin/catalogue'), false)
  })

  test('does not block unrelated paths that merely start with the same letters', () => {
    process.env.APP_EDITION = 'customer'
    assert.equal(isEditionBlockedPath('/administrate'), false)
    assert.equal(isEditionBlockedPath('/dashboard'), false)
    assert.equal(isEditionBlockedPath('/flows'), false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/__tests__/edition-middleware.test.ts`
Expected: FAIL — `isEditionBlockedPath` is not exported.

- [ ] **Step 3: Add the helper**

Append to `src/lib/edition.ts`:

```ts
/** Page prefixes the customer edition refuses outright, checked at the edge. */
const CUSTOMER_BLOCKED_PREFIXES = ['/admin']

/**
 * Whether the current edition must refuse `pathname` before any auth work.
 * Prefix matching is boundary-aware so `/administrate` is not caught by `/admin`.
 */
export function isEditionBlockedPath(pathname: string): boolean {
  if (!isCustomerEdition()) return false
  return CUSTOMER_BLOCKED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/__tests__/edition-middleware.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 5: Wire the edge check**

Replace the body of `src/middleware.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'
import { isEditionBlockedPath } from '@/lib/edition'

export async function middleware(request: NextRequest) {
  // Refused at the edge, before any session work: in the customer edition the
  // admin surface does not exist. Defence in depth over the layout's notFound()
  // and the internalOnly gate on every route the page calls.
  if (isEditionBlockedPath(request.nextUrl.pathname)) {
    return new NextResponse(null, { status: 404 })
  }
  return updateSession(request)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|mjs|map|json|txt|woff|woff2|ttf|eot)$).*)',
  ],
}
```

- [ ] **Step 6: Gate the layout**

In `src/app/admin/layout.tsx`, add the imports and the check above the existing permission redirect:

```ts
import { notFound, redirect } from 'next/navigation'
import { requireAuthContext } from '@/lib/server/auth'
import { isCustomerEdition } from '@/lib/edition'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // The customer edition has no operator console at all — not a redirect, a 404.
  if (isCustomerEdition()) notFound()
  const auth = await requireAuthContext().catch(() => null)
  if (!auth?.can('catalogue.review')) redirect('/dashboard')
  return <div className="mx-auto max-w-6xl px-6 py-8">{children}</div>
}
```

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/lib/edition.ts src/middleware.ts src/app/admin/layout.tsx src/lib/__tests__/edition-middleware.test.ts
git commit -m "feat(edition): admin surface 404s at the edge and in the layout"
```

---

### Task 7: Staff bootstrap is a hard no-op

**Files:**
- Modify: `src/lib/supabase/auth-utils.ts:41-47`
- Test: `src/lib/supabase/__tests__/staff-bootstrap-edition.test.ts`

**Interfaces:**
- Consumes: `isCustomerEdition()` from Task 1.
- Produces: no signature change. `applyStaffBootstrap(dbUser)` returns `dbUser` unmodified in the customer edition.

**This is the security-relevant task.** `applyStaffBootstrap` today promotes an allowlisted email to `platformRole: 'reviewer'` **and flips their workspace to `kind: 'internal'`**. Left reachable in a customer deployment, that is a privilege-escalation path reachable purely through environment configuration — and because `resolvePermissions` grants `catalogue.review`/`publish`/`takedown` to a reviewer in an internal org, it would hand a customer the full operator surface.

`applyStaffBootstrap` is module-private. Export it for the test rather than testing through `getAuthWithUser`, which needs a live Supabase session.

- [ ] **Step 1: Write the failing test**

Create `src/lib/supabase/__tests__/staff-bootstrap-edition.test.ts`:

```ts
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { applyStaffBootstrap } from '@/lib/supabase/auth-utils'

const priorEmails = process.env.PLATFORM_STAFF_EMAILS

afterEach(() => {
  delete process.env.APP_EDITION
  if (priorEmails === undefined) delete process.env.PLATFORM_STAFF_EMAILS
  else process.env.PLATFORM_STAFF_EMAILS = priorEmails
})

const customerUser = {
  id: 'user-1',
  email: 'operator@example.com',
  platformRole: null,
  organizationId: 'org-1',
  organization: { id: 'org-1', kind: 'customer' },
} as unknown as Parameters<typeof applyStaffBootstrap>[0]

describe('staff bootstrap', () => {
  test('is inert in the customer edition even when the email is allowlisted', async () => {
    process.env.APP_EDITION = 'customer'
    process.env.PLATFORM_STAFF_EMAILS = 'operator@example.com'

    // Returns before any DB write. Reaching Prisma here would throw, so an
    // unmodified return IS the proof that no escalation occurred.
    const result = await applyStaffBootstrap(customerUser)

    assert.equal(result, customerUser)
    assert.equal(result.platformRole, null, 'must not be promoted to reviewer')
    assert.equal(result.organization?.kind, 'customer', 'workspace must not become internal')
  })

  test('is inert for a non-allowlisted email in the internal edition', async () => {
    delete process.env.APP_EDITION
    process.env.PLATFORM_STAFF_EMAILS = 'someone-else@example.com'

    const result = await applyStaffBootstrap(customerUser)

    assert.equal(result, customerUser)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/supabase/__tests__/staff-bootstrap-edition.test.ts`
Expected: FAIL — `applyStaffBootstrap` is not exported, and the first case would reach Prisma.

- [ ] **Step 3: Export the function and guard it**

In `src/lib/supabase/auth-utils.ts`, add the import:

```ts
import { isCustomerEdition } from '@/lib/edition'
```

Change `async function applyStaffBootstrap` to `export async function applyStaffBootstrap`, and make its first statement:

```ts
  // The customer edition has no platform staff. This is a hard no-op rather
  // than a matter of leaving PLATFORM_STAFF_EMAILS unset, because this function
  // grants platformRole 'reviewer' AND flips the workspace to kind 'internal' —
  // which resolvePermissions turns into catalogue.review/publish/takedown. An
  // env var alone would make that a config mistake away in a customer deploy.
  if (isCustomerEdition()) return dbUser
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/supabase/__tests__/staff-bootstrap-edition.test.ts`
Expected: PASS, 2/2.

- [ ] **Step 5: Commit**

```bash
git add src/lib/supabase/auth-utils.ts src/lib/supabase/__tests__/staff-bootstrap-edition.test.ts
git commit -m "feat(edition): staff bootstrap cannot escalate in the customer edition"
```

---

### Task 8: Two-step onboarding

**Files:**
- Create: `src/lib/onboarding/stages.ts`
- Modify: `src/app/connect/page.tsx:33,52-53,84-130,180-294`
- Test: `src/lib/onboarding/__tests__/stages.test.ts`

**Interfaces:**
- Consumes: `isCustomerEdition()` from Task 1.
- Produces: from `src/lib/onboarding/stages.ts` —
  - `onboardingStages(): readonly string[]`
  - `liveStageIndex(): number` — index of the "Your AI goes live" stage (1 for customers, 2 internally)
  - `unlockedStage(args: { entitlementDone: boolean; meetsGate: boolean }): number`
  - `shouldForwardToDashboard(args: { entitlementDone: boolean; meetsGate: boolean; openProposals: number | null }): boolean`

Pulling this logic into a pure module is what makes it testable — the page itself has no test harness. **Three specific hazards**, each covered by a test below:

1. The redirect currently fires on `gate?.meetsGate && openProposals === 0`. Removing the proposals fetch without changing this leaves `openProposals` at `null` forever, so **onboarding hangs and never forwards to the dashboard**.
2. The 3-integration gate exists solely to gate generation. Retaining it in a build with no generation would **block customers behind a meter that unlocks nothing**.
3. `STAGES` is a fixed `as const` tuple of length 3 driving both the stepper render and the `unlockedStage` clamp; indices move with it.

- [ ] **Step 1: Write the failing test**

Create `src/lib/onboarding/__tests__/stages.test.ts`:

```ts
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { onboardingStages, liveStageIndex, unlockedStage, shouldForwardToDashboard } from '@/lib/onboarding/stages'

afterEach(() => { delete process.env.APP_EDITION })

describe('internal edition onboarding', () => {
  test('has three stages ending in the live stage', () => {
    delete process.env.APP_EDITION
    assert.deepEqual(onboardingStages(), ['Connect your tools', 'Your data takes shape', 'Your AI goes live'])
    assert.equal(liveStageIndex(), 2)
  })

  test('the integration gate still governs how far you may go', () => {
    delete process.env.APP_EDITION
    assert.equal(unlockedStage({ entitlementDone: false, meetsGate: false }), 0)
    assert.equal(unlockedStage({ entitlementDone: true, meetsGate: false }), 1)
    assert.equal(unlockedStage({ entitlementDone: true, meetsGate: true }), 2)
  })

  test('forwarding still waits for the gate and an empty proposal inbox', () => {
    delete process.env.APP_EDITION
    assert.equal(shouldForwardToDashboard({ entitlementDone: true, meetsGate: true, openProposals: 0 }), true)
    assert.equal(shouldForwardToDashboard({ entitlementDone: true, meetsGate: true, openProposals: 2 }), false)
    assert.equal(shouldForwardToDashboard({ entitlementDone: true, meetsGate: true, openProposals: null }), false)
    assert.equal(shouldForwardToDashboard({ entitlementDone: false, meetsGate: true, openProposals: 0 }), false)
  })
})

describe('customer edition onboarding', () => {
  test('collapses to two stages', () => {
    process.env.APP_EDITION = 'customer'
    assert.deepEqual(onboardingStages(), ['Connect your tools', 'Your AI goes live'])
    assert.equal(liveStageIndex(), 1)
  })

  test('entitlement alone unlocks the live stage — no integration gate', () => {
    process.env.APP_EDITION = 'customer'
    assert.equal(unlockedStage({ entitlementDone: false, meetsGate: false }), 0)
    assert.equal(unlockedStage({ entitlementDone: true, meetsGate: false }), 1)
  })

  test('forwards on entitlement alone, so onboarding cannot hang', () => {
    process.env.APP_EDITION = 'customer'
    // openProposals stays null forever because nothing fetches it. This is the
    // regression guard for the hang.
    assert.equal(shouldForwardToDashboard({ entitlementDone: true, meetsGate: false, openProposals: null }), true)
    assert.equal(shouldForwardToDashboard({ entitlementDone: false, meetsGate: false, openProposals: null }), false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/onboarding/__tests__/stages.test.ts`
Expected: FAIL — cannot find module `@/lib/onboarding/stages`.

- [ ] **Step 3: Write the stage module**

Create `src/lib/onboarding/stages.ts`:

```ts
import { isCustomerEdition } from '@/lib/edition'

const INTERNAL_STAGES = ['Connect your tools', 'Your data takes shape', 'Your AI goes live'] as const
// No "Your data takes shape": that stage IS the AI proposal inbox, and the
// customer edition generates no proposals. An empty middle step would promise
// something that never arrives.
const CUSTOMER_STAGES = ['Connect your tools', 'Your AI goes live'] as const

export function onboardingStages(): readonly string[] {
  return isCustomerEdition() ? CUSTOMER_STAGES : INTERNAL_STAGES
}

/** Index of the final "Your AI goes live" stage. */
export function liveStageIndex(): number {
  return onboardingStages().length - 1
}

/**
 * The furthest stage the user may open; they can always look back.
 *
 * The 3-integration gate exists ONLY to gate template generation, so the
 * customer edition ignores it — keeping it would block customers behind a meter
 * that unlocks nothing.
 */
export function unlockedStage({ entitlementDone, meetsGate }: { entitlementDone: boolean; meetsGate: boolean }): number {
  if (!entitlementDone) return 0
  if (isCustomerEdition()) return liveStageIndex()
  return meetsGate ? 2 : 1
}

/**
 * Whether a fully-onboarded visitor should be forwarded to the dashboard.
 *
 * The customer edition must NOT wait on `openProposals`: nothing fetches it, so
 * it stays null forever and onboarding would hang.
 */
export function shouldForwardToDashboard({
  entitlementDone,
  meetsGate,
  openProposals,
}: {
  entitlementDone: boolean
  meetsGate: boolean
  openProposals: number | null
}): boolean {
  if (!entitlementDone) return false
  if (isCustomerEdition()) return true
  return meetsGate && openProposals === 0
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/onboarding/__tests__/stages.test.ts`
Expected: PASS, 6/6.

- [ ] **Step 5: Rewire the connect page**

In `src/app/connect/page.tsx`:

a. Add imports and replace the `STAGES` const at line 33:

```ts
import { isCustomerEdition } from '@/lib/edition'
import { onboardingStages, liveStageIndex, unlockedStage as resolveUnlockedStage, shouldForwardToDashboard } from '@/lib/onboarding/stages'

const CUSTOMER = isCustomerEdition()
const STAGES = onboardingStages()
const LIVE_STAGE = liveStageIndex()
```

b. In the stage-1 data effect (lines 84-112), skip both fetches the customer edition cannot use. Wrap the `/api/integrations/count` and `/api/template-proposals` fetches:

```ts
    if (!CUSTOMER) {
      fetch('/api/integrations/count', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
          if (!cancelled && data) setGate({ connected: data.connected ?? 0, required: data.required ?? 3, meetsGate: Boolean(data.meetsGate), providers: data.providers ?? [] })
        })
        .catch(() => {})
      fetch('/api/template-proposals', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
          if (!cancelled && data?.success) setOpenProposals(((data.proposals ?? []) as { status: string }[]).filter((p) => p.status === 'open').length)
        })
        .catch(() => {
          if (!cancelled) setOpenProposals(0)
        })
    }
```

The `/api/agent-templates` fetch stays unconditional — the live stage needs it in both editions.

c. Replace the redirect effect condition at line 118:

```ts
    if (shouldForwardToDashboard({ entitlementDone, meetsGate: Boolean(gate?.meetsGate), openProposals })) {
```

d. Replace the `unlockedStage` derivation at line 127:

```ts
  const unlockedStage = resolveUnlockedStage({ entitlementDone, meetsGate: Boolean(gate?.meetsGate) })
```

e. Change the stage-1 render guard at line 273 so the proposal stage is internal-only:

```ts
        {!CUSTOMER && stage === 1 && (
```

f. Change the live-stage render guard (currently `{stage === 2 && (`) to:

```ts
        {stage === LIVE_STAGE && (
```

and change the `setStage(2)` call inside the stage-1 section (line 288) to `setStage(LIVE_STAGE)`.

g. In the "Step 3" card (lines 233-263), the copy promises AI learning that will never happen for a customer. Render the meter, the promise and the "See what your AI found" button only in the internal edition, and give the customer edition an honest equivalent:

```tsx
              {entitlementDone && (
                <div className="rounded-lg border p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Step 3</p>
                  <p className="mt-0.5 text-sm font-semibold text-gray-900">Connect the tools your team works in</p>
                  {CUSTOMER ? (
                    <p className="mt-1 text-sm leading-5 text-gray-600">
                      Connect the tools your agents should work across. You can add more at any time.
                    </p>
                  ) : (
                    <>
                      <p className="mt-1 text-sm leading-5 text-gray-600">
                        Once {gate?.required ?? 3} tools are connected, your AI starts learning how your team uses them and
                        drafts automations for you.
                      </p>
                      <div className="mt-3 h-2 overflow-hidden rounded-full bg-gray-100">
                        <div className="h-full rounded-full bg-gray-900 transition-all" style={{ width: `${meter.percent}%` }} />
                      </div>
                      <p className="mt-1.5 text-xs font-medium text-gray-600">{meter.label}</p>
                    </>
                  )}
                  <div className="mt-3 flex gap-2">
                    <Link
                      href="/integrations"
                      className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                    >
                      Open integrations <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                    {(CUSTOMER || meter.meetsGate) && (
                      <button
                        type="button"
                        onClick={() => setStage(CUSTOMER ? LIVE_STAGE : 1)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800"
                      >
                        {CUSTOMER ? 'Your AI goes live' : 'See what your AI found'} <ArrowRight className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              )}
```

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: clean. If `meter` or `ProposalInbox` is reported unused, it is not — both are still referenced on the internal path.

- [ ] **Step 7: Commit**

```bash
git add src/lib/onboarding/stages.ts src/lib/onboarding/__tests__/stages.test.ts src/app/connect/page.tsx
git commit -m "feat(edition): two-step onboarding for the customer edition"
```

---

### Task 9: Gate-inventory completeness check

**Files:**
- Modify: `src/app/api/__tests__/edition-gates.test.ts`

**Interfaces:**
- Consumes: `INTERNAL_ONLY_ROUTES` from Task 3.
- Produces: nothing.

Mirrors the existing completeness self-check in `route-smoke.test.ts:149-172`. Without it, a future internal-only route could be added with no conscious decision about the customer edition — or a gate could be silently dropped.

- [ ] **Step 1: Write the failing test**

Append to `src/app/api/__tests__/edition-gates.test.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

describe('gate inventory', () => {
  test('every internalOnly route is in the documented inventory, and vice versa', () => {
    const apiDir = fileURLToPath(new URL('..', import.meta.url))
    const walk = (dir: string): string[] => {
      const out: string[] = []
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__') continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) out.push(...walk(full))
        else if (entry.name === 'route.ts') out.push(full)
      }
      return out
    }

    const onDisk = walk(apiDir)
      .filter((file) => /internalOnly:\s*true/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(apiDir, path.dirname(file)))
      .sort()

    assert.deepEqual(
      onDisk,
      [...INTERNAL_ONLY_ROUTES].sort(),
      'internalOnly routes drifted from INTERNAL_ONLY_ROUTES. Adding an internal-only route is a deliberate customer-edition decision: add it to the inventory above with a 404 case, or remove the gate.',
    )
  })
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/edition-gates.test.ts`
Expected: PASS, 12/12. (This one passes immediately — Task 3 already gated exactly these eight routes. Its value is as a regression guard.)

- [ ] **Step 3: Verify the check actually fails when it should**

Temporarily delete `'catalogue/staff'` from the `INTERNAL_ONLY_ROUTES` array and re-run.
Expected: FAIL naming `catalogue/staff`. **Restore the line** and re-run to confirm PASS. A completeness test that cannot fail is worse than none.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/__tests__/edition-gates.test.ts
git commit -m "test(edition): completeness check over the internalOnly inventory"
```

---

### Task 10: Full gate, then mirror to Backstory_customers

**Files:**
- Modify: `README.md`
- Create: `docs/runbooks/customer-edition.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a `Backstory_customers` repo carrying full history plus one commit flipping `EDITION`.

`Backstory_customers` is currently an empty repo (no refs). The customer clone lives at `/Users/james.mcdaniel/Backstory_customers` — a sibling of this repo, never nested inside it.

- [ ] **Step 1: Run the full gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green, with the pre-existing lint warnings only. **Do not proceed if anything fails** — the mirror would carry the failure into a second repo.

- [ ] **Step 2: Document the edition upstream**

Append to `README.md`, after the "Architecture" section:

```markdown
## Editions

This tree builds in two editions, selected by the single constant in
`src/lib/edition.config.ts`:

- **`internal`** (this repo) — the full platform.
- **`customer`** (`Backstory_customers`) — the customer-facing build. The AI
  template-generation pipeline and the cross-workspace staff console are gated
  off, and onboarding is two steps rather than three.

`Backstory_customers` is a mirror of this tree whose only permanent diff is that
constant, so `git merge upstream/main` carries every feature across cleanly. Never
import `EDITION` directly — use `isCustomerEdition()` from `src/lib/edition.ts`.

Adding an internal-only surface is a deliberate decision: gate the route with
`internalOnly: true` and add it to `INTERNAL_ONLY_ROUTES` in
`src/app/api/__tests__/edition-gates.test.ts`, which fails the build on drift.
```

- [ ] **Step 3: Write the runbook**

Create `docs/runbooks/customer-edition.md`:

```markdown
# Customer edition runbook

## Syncing upstream features into Backstory_customers

```bash
cd /Users/james.mcdaniel/Backstory_customers
git fetch upstream
git merge upstream/main
npm test
git push origin main
```

`src/lib/edition.config.ts` is the only file that differs, and upstream never
edits it, so this merge does not conflict. If it ever does, keep the fork's
`EDITION = 'customer'` line and take upstream's version of everything else.

## Verifying the gates on the customer deploy

After any deploy, confirm all four return 404 while signed in as a workspace admin:

- `/admin/catalogue`
- `/api/catalogue/staff`
- `/api/template-proposals`
- `/api/catalogue/review`

And confirm onboarding forwards: a fully-entitled workspace landing on `/connect`
must reach `/dashboard` without needing three integrations connected.

## Deployment differences

Separate Vercel project, separate database, separate Supabase project. Leave
`PLATFORM_STAFF_EMAILS` unset — belt and braces alongside the code-level no-op in
`applyStaffBootstrap`. Cron entries in `vercel.json` are identical; the
generation sweep returns `[]` on its own.
```

- [ ] **Step 4: Commit the documentation**

```bash
git add README.md docs/runbooks/customer-edition.md
git commit -m "docs(edition): editions in the README plus a customer-edition runbook"
```

- [ ] **Step 5: Push upstream**

```bash
git push origin main
```

- [ ] **Step 6: Seed the customer repo with full history**

```bash
git remote add customers https://github.com/jamesmcdaniel-cyber/Backstory_customers.git
git push customers main:main
```

Expected: the full history lands. Preserving provenance is why this is a push rather than a fresh init.

- [ ] **Step 7: Clone and flip the constant**

```bash
git clone https://github.com/jamesmcdaniel-cyber/Backstory_customers.git /Users/james.mcdaniel/Backstory_customers
cd /Users/james.mcdaniel/Backstory_customers
git remote add upstream https://github.com/jamesmcdaniel-cyber/Backstory_Studio.git
```

Edit `src/lib/edition.config.ts`, changing exactly one line:

```ts
export const EDITION: Edition = 'customer'
```

- [ ] **Step 8: Prove the customer edition is live**

```bash
cd /Users/james.mcdaniel/Backstory_customers
npm ci
npm run typecheck && npm test
```

Expected: all green. Note that with `EDITION = 'customer'` committed, the tests
that `delete process.env.APP_EDITION` now resolve to `customer`, so any case
asserting internal-edition behavior without an explicit override will fail here.
**If that happens, fix the tests to set `process.env.APP_EDITION = 'internal'`
explicitly rather than relying on the default — and port that fix upstream**, so
both repos run the same suite. This is the one place the two trees can legitimately
disagree, and it must be resolved in the tests, never by weakening a gate.

- [ ] **Step 9: Commit and push the fork**

```bash
cd /Users/james.mcdaniel/Backstory_customers
git add src/lib/edition.config.ts
git commit -m "feat: select the customer edition

The only permanent diff from Backstory_Studio. Gates off AI template
generation and the staff console; onboarding is two steps."
git push origin main
```

- [ ] **Step 10: Verify the fork's diff is exactly one file**

```bash
cd /Users/james.mcdaniel/Backstory_customers
git fetch upstream
git diff upstream/main --stat
```

Expected: `src/lib/edition.config.ts` only (plus any test files touched in Step 8). If any other file differs, the mirror has drifted — reconcile before deploying.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Edition constant + accessor, fail-safe rationale | 1 |
| API route gate (`internalOnly`) | 2 |
| Scope A — proposal routes gated | 3 |
| Scope A — generation entry points, worker queue | 4 |
| Scope A — inert client provider | 5 |
| Scope B — admin page + edge | 6 |
| Scope B — staff-bootstrap no-op | 7 |
| Scope B — catalogue staff/review/entries routes | 3 |
| Scope C — two-step onboarding, all three hazards | 8 |
| Scope D — usage untouched | none, by design (Global Constraints) |
| Testing — customer-edition assertions | 1, 2, 3, 4, 6, 7, 8 |
| Testing — completeness check | 9 |
| Repo setup, upstream remote, README | 10 |
| Non-goals — no deletions, no schema change | Global Constraints |

**Placeholder scan:** none — every code step carries the actual content.

**Type consistency:** `isCustomerEdition()` is the single accessor used by Tasks 2–8; `Edition` is defined in `edition.ts` and imported by `edition.config.ts` (Task 1); `INTERNAL_ONLY_ROUTES` is produced in Task 3 and consumed in Task 9; `unlockedStage` is imported as `resolveUnlockedStage` in the page to avoid colliding with the local const it replaces (Task 8).

**Known cross-repo wrinkle:** Step 8 of Task 10 flags that flipping the committed constant changes what `delete process.env.APP_EDITION` resolves to, and requires the fix to land in the tests upstream rather than in a gate.
