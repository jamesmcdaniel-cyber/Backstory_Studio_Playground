import { Prisma, PrismaClient } from '@prisma/client'
import type { ITXClientDenyList } from '@prisma/client/runtime/library'
import { assertOrgScoped, ORG_SCOPED_MODELS } from '@/lib/tenant-guard'
import { exactOrganizationId, tenantDatabaseContext } from '@/lib/tenant-database-context'

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

function assertProductionDatabaseIsolation(): void {
  if (process.env.NODE_ENV !== 'production') return
  if (process.env.DATABASE_RLS_ENABLED !== 'true') {
    throw new Error('DATABASE_RLS_ENABLED=true is required in production')
  }
  const appUrl = process.env.DATABASE_URL
  const systemUrl = process.env.SYSTEM_DATABASE_URL
  if (!appUrl || !systemUrl) {
    throw new Error('Production requires distinct DATABASE_URL and SYSTEM_DATABASE_URL roles')
  }
  if (appUrl === systemUrl) {
    throw new Error('DATABASE_URL must not use the privileged SYSTEM_DATABASE_URL role')
  }
  try {
    if (new URL(appUrl).username === new URL(systemUrl).username) {
      throw new Error('DATABASE_URL and SYSTEM_DATABASE_URL must use distinct database roles')
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('distinct database roles')) throw error
    throw new Error('DATABASE_URL and SYSTEM_DATABASE_URL must be valid PostgreSQL URLs')
  }
}

assertProductionDatabaseIsolation()

function createGuardedClient(base: PrismaClient) {
  // Tenant guard: org-carrying models must be queried with organizationId.
  // See src/lib/tenant-guard.ts. System-wide paths use systemPrisma below.
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          assertOrgScoped(model, operation, args)
          if (process.env.DATABASE_RLS_ENABLED === 'true' && model && ORG_SCOPED_MODELS.has(model)) {
            const organizationId = exactOrganizationId(args)
            if (!organizationId) throw new Error(`RLS context: ${model}.${operation} requires one exact organizationId.`)
            const active = tenantDatabaseContext.getStore()
            if (active) {
              if (active.organizationId !== organizationId) throw new Error('RLS context: cross-workspace query rejected.')
              const delegate = (active.transaction as unknown as Record<string, Record<string, (value: unknown) => unknown>>)[model.charAt(0).toLowerCase() + model.slice(1)]
              return delegate[operation](args)
            }
            return appPrismaBase.$transaction(async (tx) => {
              await tx.$queryRaw`SELECT set_config('app.organization_id', ${organizationId}, true)`
              const delegate = (tx as unknown as Record<string, Record<string, (value: unknown) => unknown>>)[model.charAt(0).toLowerCase() + model.slice(1)]
              return delegate[operation](args)
            })
          }
          return query(args)
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
export const systemPrisma = globalForPrisma.systemPrisma ?? createPrismaClient(process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL)
globalForPrisma.systemPrisma = systemPrisma

const appPrismaBase = globalForPrisma.appPrismaBase ?? (process.env.DATABASE_RLS_ENABLED === 'true'
  ? createPrismaClient(process.env.DATABASE_URL)
  : systemPrisma)
globalForPrisma.appPrismaBase = appPrismaBase

export const prisma = globalForPrisma.prisma ?? createGuardedClient(appPrismaBase)

/** Run an atomic tenant operation with SET LOCAL so PostgreSQL RLS is the final boundary. */
export function tenantTransaction<T>(organizationId: string, callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return appPrismaBase.$transaction(async (tx) => {
    if (process.env.DATABASE_RLS_ENABLED === 'true') {
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
