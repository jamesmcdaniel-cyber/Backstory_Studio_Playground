import { PrismaClient } from '@prisma/client'
import type { ITXClientDenyList } from '@prisma/client/runtime/library'
import { assertOrgScoped } from '@/lib/tenant-guard'

const globalForPrisma = globalThis as unknown as {
  prisma?: ReturnType<typeof createGuardedClient>
  systemPrisma?: PrismaClient
}

function createPrismaClient() {
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  })
}

function createGuardedClient(base: PrismaClient) {
  // Tenant guard: org-carrying models must be queried with organizationId.
  // See src/lib/tenant-guard.ts. System-wide paths use systemPrisma below.
  return base.$extends({
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          assertOrgScoped(model, operation, args)
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
export const systemPrisma = globalForPrisma.systemPrisma ?? createPrismaClient()
globalForPrisma.systemPrisma = systemPrisma

export const prisma = globalForPrisma.prisma ?? createGuardedClient(systemPrisma)

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
