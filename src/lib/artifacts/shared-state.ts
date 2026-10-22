import { prisma, tenantTransaction } from '@/lib/prisma'
import { ApiError } from '@/lib/server/api-handler'
import { Prisma } from '@prisma/client'
import { MAX_STATE_BYTES } from './app-state'
import { broadcastChannelTick } from '@/lib/flows/run-stream'
import { trackDetached } from '@/lib/flows/keep-alive'
import { artifactSharedChannel } from './shared-state-live'

/**
 * State an artifact's viewers share — the mirror of app-state.ts without the
 * person: one value per artifact + key, the same compare-and-set revision,
 * the same key and size limits. Anyone who can read the artifact reads it;
 * anyone who can edit it writes it (the routes decide; this file trusts its
 * scope).
 *
 * Live: a successful write fires a tick on `artifact-shared:<artifactId>`
 * carrying only `{ key, revision }` (see shared-state-live.ts for why that is
 * safe on a public channel); open viewers refetch the key through the
 * authenticated route. A refused write (conflict, limit, stale version)
 * changed nothing and broadcasts nothing.
 */
export const MAX_SHARED_STATE_KEYS = 32
type Scope = { organizationId: string; artifactId: string; key: string }

export async function readSharedState(scope: Scope) {
  const row = await prisma.artifactSharedState.findFirst({ where: scope, select: { value: true, revision: true } })
  return row ?? { value: null, revision: 0 }
}

/** Tell open viewers a key moved to `revision`. Never the value. No-op without Supabase. */
export function broadcastSharedStateTick(artifactId: string, tick: { key: string; revision: number }): Promise<void> | undefined {
  return broadcastChannelTick(artifactSharedChannel(artifactId), { key: tick.key, revision: tick.revision })
}

export async function writeSharedState(scope: Scope, revision: number, value: unknown, versionId: string, userId: string) {
  const saved = await commitSharedState(scope, revision, value, versionId, userId)
  // After the commit, outside the row lock: a viewer that refetches on this
  // tick must see the new row. Held open past the response, never awaited.
  trackDetached(broadcastSharedStateTick(scope.artifactId, { key: scope.key, revision: saved.revision }))
  return saved
}

async function commitSharedState(scope: Scope, revision: number, value: unknown, versionId: string, userId: string) {
  const encoded = JSON.stringify(value)
  if (encoded === undefined || Buffer.byteLength(encoded) > MAX_STATE_BYTES) throw new ApiError('Shared state exceeds 256 KB.', 413, 'STATE_TOO_LARGE')
  const data = value === null ? Prisma.JsonNull : JSON.parse(encoded) as Prisma.InputJsonValue
  return tenantTransaction(scope.organizationId, async (tx) => {
    // Same lock as private state (app-state.ts): a plain row lock, not an
    // update — an update would bump the artifact's updatedAt, which the
    // conversation writes compare-and-swap on. A stale frame cannot overwrite
    // the shared value a newer source version is working from.
    const valid = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "artifacts" WHERE "id" = ${scope.artifactId} AND "organizationId" = ${scope.organizationId}::uuid AND "currentVersionId" = ${versionId} AND "archivedAt" IS NULL FOR UPDATE`
    if (!valid.length) throw new ApiError('The artifact version changed. Reload before saving shared data.', 409, 'STATE_CONFLICT')
    if (revision === 0) {
      const count = await tx.artifactSharedState.count({ where: { organizationId: scope.organizationId, artifactId: scope.artifactId } })
      if (count >= MAX_SHARED_STATE_KEYS) throw new ApiError(`This artifact already has ${MAX_SHARED_STATE_KEYS} shared state keys.`, 413, 'STATE_LIMIT')
      const created = await tx.artifactSharedState.createMany({ data: [{ ...scope, value: data, updatedByUserId: userId }], skipDuplicates: true })
      if (!created.count) throw new ApiError('Shared data changed elsewhere. Reload to reconcile.', 409, 'STATE_CONFLICT')
      return { revision: 1 }
    }
    const changed = await tx.artifactSharedState.updateMany({ where: { ...scope, revision }, data: { value: data, revision: { increment: 1 }, updatedByUserId: userId } })
    if (!changed.count) throw new ApiError('Shared data changed elsewhere. Reload to reconcile.', 409, 'STATE_CONFLICT')
    return { revision: revision + 1 }
  })
}
