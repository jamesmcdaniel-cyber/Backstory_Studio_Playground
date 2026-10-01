import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError } from '@/lib/server/api-handler'
import { Prisma } from '@prisma/client'

export const stateKeySchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)
export const stateWriteSchema = z.object({ key: stateKeySchema, revision: z.number().int().min(0), value: z.unknown(), versionId: z.string().min(1) }).strict()
export const MAX_STATE_BYTES = 256_000
type Scope = { organizationId: string; artifactId: string; userId: string; key: string }

export async function readAppState(scope: Scope) {
  const row = await prisma.artifactAppState.findFirst({ where: scope, select: { value: true, revision: true } })
  return row ?? { value: null, revision: 0 }
}

export async function writeAppState(scope: Scope, revision: number, value: unknown, versionId: string) {
  const encoded = JSON.stringify(value)
  if (encoded === undefined || Buffer.byteLength(encoded) > MAX_STATE_BYTES) throw new ApiError('Application state exceeds 256 KB.', 413, 'STATE_TOO_LARGE')
  const data = value === null ? Prisma.JsonNull : JSON.parse(encoded) as Prisma.InputJsonValue
  return prisma.$transaction(async (tx) => {
    // Lock the same artifact row as a source-version save. Old/history frames
    // cannot race a newly-published source version and overwrite its state.
    const valid = await tx.artifact.updateMany({ where: { id: scope.artifactId, organizationId: scope.organizationId, currentVersionId: versionId, archivedAt: null }, data: { currentVersionId: versionId } })
    if (!valid.count) throw new ApiError('The artifact version changed. Reload before saving application data.', 409, 'STATE_CONFLICT')
    if (revision === 0) {
      const count = await tx.artifactAppState.count({ where: { organizationId: scope.organizationId, artifactId: scope.artifactId, userId: scope.userId } })
      if (count >= 32) throw new ApiError('This artifact already has 32 state keys.', 413, 'STATE_LIMIT')
      const created = await tx.artifactAppState.createMany({ data: [{ ...scope, value: data }], skipDuplicates: true })
      if (!created.count) throw new ApiError('Application data changed in another tab. Reload to reconcile.', 409, 'STATE_CONFLICT')
      return { revision: 1 }
    }
    const changed = await tx.artifactAppState.updateMany({ where: { ...scope, revision }, data: { value: data, revision: { increment: 1 } } })
    if (!changed.count) throw new ApiError('Application data changed in another tab. Reload to reconcile.', 409, 'STATE_CONFLICT')
    return { revision: revision + 1 }
  })
}
