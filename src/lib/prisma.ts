import { Prisma, PrismaClient } from '@prisma/client'
import type { ITXClientDenyList } from '@prisma/client/runtime/library'
import { assertOrgScoped, ORG_SCOPED_MODELS } from '@/lib/tenant-guard'
import { applyOwnerLiveness } from '@/lib/authz/credential-owner-guard'
import { ambientOrganization, exactOrganizationId, tenantDatabaseContext } from '@/lib/tenant-database-context'
import { assertRlsContext, RLS_PARENT_SCOPED_MODELS, rlsActive, rlsAppliesTo } from '@/lib/authz/rls-rollout'
import { applyFlowSecretScan, applyRunDataRedaction } from '@/lib/flows/run-data-guard'

const globalForPrisma = globalThis as unknown as {
  prisma?: ReturnType<typeof createGuardedClient>
  systemPrisma?: PrismaClient
  appPrismaBase?: PrismaClient
}

function createPrismaClient(datasourceUrl?: string) {
  return new PrismaClient({
    ...(datasourceUrl ? { datasourceUrl } : {}),
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  })
}

function createGuardedClient(base: PrismaClient) {
  // Tenant guard: org-carrying models must be queried with organizationId.
  // See src/lib/tenant-guard.ts. System-wide paths use systemPrisma below.
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          assertOrgScoped(model, operation, args)
          // AFTER the tenant guard, so it judges the caller's OWN where clause
          // rather than one this has already rewritten. The injected filter
          // carries no organizationId, so letting the guard see it first would
          // change nothing it accepts — but the ordering is load-bearing if that
          // ever stops being true. See src/lib/authz/credential-owner-guard.ts.
          const ownerScoped = applyOwnerLiveness(model, operation, args) as typeof args
          // Run data (step input/output/logs, run trigger/output) is redacted on
          // the way IN. Written from ~8 places in the executor, so redacting at
          // each call site means the ninth added later silently reopens it —
          // and a read-time filter would leave the plaintext in every backup and
          // replica anyway. The value of a secret in run history is that it is
          // stored, not that it is displayed.
          const runScoped = applyRunDataRedaction(model, operation, ownerScoped) as typeof args
          // Same chokepoint, opposite direction: run data is REDACTED on the way
          // in, and a flow graph is ANNOTATED with the literal credentials it
          // appears to carry. Advisory — the save always succeeds — but computed
          // in the same write, so the findings can never describe a graph that
          // is no longer stored.
          const guardedArgs = applyFlowSecretScan(model, operation, runScoped) as typeof args
          // Parent-scoped models (flow run steps, collaborators, execution
          // messages) have no organizationId to route on, but their policies
          // still read app.organization_id. Absent it, PostgreSQL returns zero
          // rows with no error.
          //
          // Inside a tenantTransaction the setting is already there. Otherwise
          // fall back to the ambient organization the API wrapper or execution
          // engine established, and open a transaction for just this query.
          // Only when there is neither is the query genuinely unattributable,
          // and assertRlsContext throws rather than let it return empty.
          if (model && rlsActive() && RLS_PARENT_SCOPED_MODELS.has(model)) {
            const active = tenantDatabaseContext.getStore()
            if (!active) {
              const organizationId = ambientOrganization.getStore()
              assertRlsContext(model, operation, Boolean(organizationId))
              return appPrismaBase.$transaction(async (tx) => {
                await tx.$queryRaw`SELECT set_config('app.organization_id', ${organizationId!}, true)`
                const delegate = (tx as unknown as Record<string, Record<string, (value: unknown) => unknown>>)[model.charAt(0).toLowerCase() + model.slice(1)]
                return delegate[operation](guardedArgs)
              })
            }
          }
          // Per-model, not a global boolean: see src/lib/authz/rls-rollout.ts
          // for why enabling every table at once is what caused the outages.
          if (rlsAppliesTo(model) && model && ORG_SCOPED_MODELS.has(model)) {
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
      },
    },
  })
}

/**
 * Unguarded client for enumerated system paths ONLY (cron sweeps, reapers,
 * tenant resolution, auth bootstrap, worker-internal id-keyed writes). Every
 * call site carries a one-line justification comment. User-facing code uses
 * `prisma`.
 */
/**
 * Refuse to boot in the one configuration that silently recreates the third
 * 2026-08-09 outage.
 *
 * `systemPrisma` falls back to DATABASE_URL when SYSTEM_DATABASE_URL is unset.
 * That fallback is correct while RLS is off (both are the privileged role) and
 * catastrophic the moment it is on: DATABASE_URL is then the non-owner
 * `backstory_app` role, so every "system" path — cron sweeps, tenant resolution,
 * auth bootstrap, and the platform tables carrying deny-all `tenant_no_access`
 * policies — runs as a role those policies reject. Last time that surfaced as
 * every workspace reporting "Your workspace is still provisioning".
 *
 * Nothing about it is loud: `??` produces a working connection, and the failure
 * appears later as empty reads. Fail at boot instead.
 */
if (rlsActive() && !process.env.SYSTEM_DATABASE_URL) {
  throw new Error(
    'DATABASE_RLS_ENABLED is set but SYSTEM_DATABASE_URL is not. systemPrisma would fall back to ' +
      'DATABASE_URL — the non-owner role — and every system path, including the deny-all platform ' +
      'tables, would read as a role its policies reject. Set SYSTEM_DATABASE_URL to the privileged ' +
      'connection before enabling RLS.',
  )
}

export const systemPrisma = globalForPrisma.systemPrisma ?? createPrismaClient(process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL)
globalForPrisma.systemPrisma = systemPrisma

// The non-owner application role is only worth a second pool once at least one
// model is actually on the RLS path; before that every query would take the
// same connections through a role with nothing to enforce.
const appPrismaBase = globalForPrisma.appPrismaBase ?? (rlsActive()
  ? createPrismaClient(process.env.DATABASE_URL)
  : systemPrisma)
globalForPrisma.appPrismaBase = appPrismaBase

/**
 * Built on `systemPrisma`, NOT `appPrismaBase`.
 *
 * The base client serves every query the RLS branch does not explicitly route —
 * that is, every model not yet named in DATABASE_RLS_ENABLED. Those must keep
 * using the owner connection, which bypasses RLS, exactly as they did before the
 * rollout began.
 *
 * Building on `appPrismaBase` instead put the whole client on the non-owner role
 * the moment a SINGLE model was staged, while only that staged model had
 * `app.organization_id` set. Every other org-scoped table then matched its
 * tenant_isolation policy against an unset setting and returned zero rows —
 * so staging one table emptied all the others. Measured: with
 * DATABASE_RLS_ENABLED=Flow, `Flow.findMany` returned 1 row and
 * `FlowRun.findMany` returned 0 for the same tenant.
 *
 * That is the whole point of a staged rollout inverted: it made enabling one
 * model strictly more dangerous than enabling all of them.
 */
export const prisma = globalForPrisma.prisma ?? createGuardedClient(systemPrisma)

/** Run an atomic tenant operation with SET LOCAL so PostgreSQL RLS is the final boundary. */
export function tenantTransaction<T>(organizationId: string, callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return appPrismaBase.$transaction(async (tx) => {
    if (rlsActive()) {
      await tx.$queryRaw`SELECT set_config('app.organization_id', ${organizationId}, true)`
    }
    return tenantDatabaseContext.run({ organizationId, transaction: tx }, () => callback(tx))
  })
}

/**
 * The `tx` handed to `prisma.$transaction(async (tx) => …)`.
 *
 * NOT `Prisma.TransactionClient` — that's the un-extended client type, and the
 * tenant guard is a `$extends` query extension, so the extended client's tx has
 * a different (guarded) shape. Helpers that take a transaction must use this,
 * or they type-check against a client that has no guard on it.
 */
export type GuardedTransactionClient = Omit<typeof prisma, ITXClientDenyList>
// Cache in all environments: on Vercel this reuses one client (and its pool)
// across warm serverless invocations. The guarded client wraps the SAME
// underlying connection pool as systemPrisma — one pool, two lenses.
globalForPrisma.prisma = prisma
