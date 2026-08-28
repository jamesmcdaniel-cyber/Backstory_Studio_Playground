import { AsyncLocalStorage } from 'node:async_hooks'
import type { Prisma } from '@prisma/client'

export type TenantDatabaseContext = {
  organizationId: string
  transaction: Prisma.TransactionClient
}

export const tenantDatabaseContext = new AsyncLocalStorage<TenantDatabaseContext>()

/**
 * The organization the current work belongs to, without holding a transaction.
 *
 * `tenantDatabaseContext` carries an OPEN transaction, so it can only be
 * established around an atomic unit of work. Parent-scoped models
 * (FlowRunStep, WorkflowStep, ExecutionMessage, WorkflowEvent,
 * FlowCollaborator) need a tenant id for a single query, in code that has no
 * reason to open a transaction — the flow execution engine writing a step row,
 * an API route reading step history.
 *
 * Without this the only options were to thread `tenantTransaction` through
 * ~43 call sites across the execution engine and nine API routes, or to route
 * them all through the unguarded system client and give up the database
 * boundary for them entirely. This is neither: the guard in src/lib/prisma.ts
 * reads this and opens a correctly-scoped transaction for exactly the query
 * that needs one.
 *
 * Set by `withAuthenticatedApi` (from the caller's own auth context) and by the
 * flow and agent execution engines (from the job's organizationId). It is a
 * hint about WHICH tenant, never a grant of access: every read still goes
 * through the tenant guard, and PostgreSQL's policy is still what enforces.
 */
export const ambientOrganization = new AsyncLocalStorage<string>()

/**
 * Process-global test seam for the ambient tenant, mirroring
 * `setTestAuthContext` in src/lib/server/auth.ts (same `Symbol.for` slot
 * technique, same activation gate, and for the same reason).
 *
 * `AsyncLocalStorage.enterWith` does not cross node:test's hook boundary — a
 * value entered in `before()` is invisible inside the `test()` bodies that
 * follow, because the runner spawns each as its own async resource from the
 * root context. (Verified: `getStore()` returns undefined in the test body.)
 * DB-backed tests seed their org in `before()` and assert in the test bodies,
 * so without a slot that outlives the hook every parent-scoped read in those
 * tests runs with no tenant — a configuration production never produces, since
 * production always enters through the API wrapper or an execution engine.
 *
 * Node's test runner isolates each FILE in its own process, so this slot is
 * file-scoped in practice and one suite cannot inherit another's tenant.
 */
const TEST_TENANT_SLOT = Symbol.for('backstory.testAmbientOrganization')

export function setTestAmbientOrganization(organizationId: string | null): void {
  ;(globalThis as unknown as Record<symbol, unknown>)[TEST_TENANT_SLOT] = organizationId
}

/**
 * The tenant the current work belongs to: the AsyncLocalStorage value when one
 * is established (always, in production), falling back to the test slot only
 * outside production and only while TEST_DATABASE_URL is set — the same two
 * conditions that gate the auth seam.
 *
 * Every reader of the ambient tenant goes through this rather than
 * `ambientOrganization.getStore()` directly, so the seam cannot be half-applied.
 */
export function currentAmbientOrganization(): string | undefined {
  const active = ambientOrganization.getStore()
  if (active) return active
  if (process.env.NODE_ENV === 'production' || !process.env.TEST_DATABASE_URL) return undefined
  return ((globalThis as unknown as Record<symbol, unknown>)[TEST_TENANT_SLOT] as string | null) ?? undefined
}

export function exactOrganizationId(value: unknown): string | null {
  const found = new Set<string>()
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(visit)
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'organizationId') {
        if (typeof item === 'string') found.add(item)
        else if (item && typeof item === 'object') {
          const filter = item as { equals?: unknown; in?: unknown }
          if (typeof filter.equals === 'string') found.add(filter.equals)
          if (Array.isArray(filter.in) && filter.in.length === 1 && typeof filter.in[0] === 'string') found.add(filter.in[0])
        }
      }
      visit(item)
    }
  }
  visit(value)
  return found.size === 1 ? [...found][0] : null
}
