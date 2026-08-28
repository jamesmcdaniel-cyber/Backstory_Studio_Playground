import { ambientOrganization, setTestAmbientOrganization } from '@/lib/tenant-database-context'

/**
 * Tenant context for DB-backed tests.
 *
 * Deliberately a LEAF module: it imports `@/lib/tenant-database-context` and
 * nothing else, so importing it cannot pull `@/lib/prisma` into the module
 * graph. DB-backed tests assign `process.env.DATABASE_URL = TEST_DATABASE_URL`
 * at module scope and then `await import('@/lib/prisma')` inside `before()`,
 * because the Prisma client reads the URL once at construction. A helper that
 * reached the client through `test-auth.ts` (which imports `../auth`, which
 * imports the client) would construct it against the developer's real
 * DATABASE_URL before the test ever set the test one.
 */

/**
 * Operate as `organizationId` for the rest of this async context — the same
 * context production establishes in `withAuthenticatedApi`, `runFlowExecution`,
 * `runAgentExecution`, and `generateTemplateProposals`.
 *
 * Needed under RLS by the parent-scoped models (FlowRunStep, WorkflowStep,
 * ExecutionMessage, WorkflowEvent, FlowCollaborator), which are tenanted
 * through a parent row rather than a column of their own: with no
 * `app.organization_id` their policies match nothing and PostgreSQL returns
 * zero rows and no error. A test that drives an engine and then reads back the
 * rows it wrote sits below every production entry point, so without this it
 * runs in a configuration production never produces.
 *
 * `enterWith` rather than `run`: the context has to outlive the call that
 * establishes it and cover the assertions that follow.
 *
 * Effectively a no-op while RLS is off — the guard only reads the value when
 * `DATABASE_RLS_ENABLED` names models — so it costs nothing on the default
 * test path.
 */
export function enterTestTenant(organizationId: string): void {
  // Both, deliberately. `enterWith` covers the current async context — which is
  // what a helper called from inside a test body needs — and the process slot
  // covers the hook boundary, because a value entered in `before()` is NOT
  // visible inside the `test()` bodies that follow it.
  ambientOrganization.enterWith(organizationId)
  setTestAmbientOrganization(organizationId)
}

/**
 * Leave the tenant. AsyncLocalStorage has no "unset" for `enterWith`, so this
 * enters a sentinel the guard reads as absent, keeping `clearTestAuth()`
 * honest: a later unattributed query must fail closed rather than silently
 * inherit the previous test's tenant.
 */
export function exitTestTenant(): void {
  ambientOrganization.enterWith(undefined as unknown as string)
  setTestAmbientOrganization(null)
}
