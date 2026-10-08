import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma, tenantTransaction } from '@/lib/prisma'

/**
 * What a version's page reported about itself from the viewer: uncaught
 * errors, rejected promises and console.error, as the frame's runtime
 * captured them (src/lib/artifacts/client-runtime.ts). One row per artifact +
 * version — the latest report replaces the last — so the assistant's
 * get_artifact can say what broke, and the viewer can offer to fix it.
 */
export const MAX_RENDER_ERRORS = 20
export const MAX_RENDER_ERROR_CHARS = 500

export const renderErrorSchema = z.object({
  message: z.string().min(1).max(MAX_RENDER_ERROR_CHARS),
  stack: z.string().max(MAX_RENDER_ERROR_CHARS).optional(),
  count: z.number().int().min(1).max(100_000).optional(),
}).strict()
export const renderErrorsWriteSchema = z.object({ versionId: z.string().min(1).max(80), errors: z.array(renderErrorSchema).max(MAX_RENDER_ERRORS) }).strict()
export type RenderError = z.infer<typeof renderErrorSchema>
export type RenderErrorReport = { versionId: string; errors: RenderError[]; reportedAt: string; reportedByUserId: string | null }

type Scope = { organizationId: string; artifactId: string }

/** Store the latest report for this version; an empty list clears it. */
export async function recordRenderErrors(scope: Scope, versionId: string, userId: string | null, errors: RenderError[]): Promise<void> {
  const where = { organizationId: scope.organizationId, artifactId: scope.artifactId, versionId }
  await tenantTransaction(scope.organizationId, async (tx) => {
    // The version must belong to this artifact: a frame cannot pin errors on another artifact's version.
    const version = await tx.artifactVersion.findFirst({ where: { id: versionId, artifactId: scope.artifactId, organizationId: scope.organizationId }, select: { id: true } })
    if (!version) return
    await tx.artifactRenderError.deleteMany({ where })
    if (!errors.length) return
    await tx.artifactRenderError.create({ data: { ...where, userId, errors: errors as Prisma.InputJsonValue } })
  })
}

/** The latest report for a version, if any. */
export async function latestRenderErrors(scope: Scope, versionId: string): Promise<RenderErrorReport | null> {
  const row = await prisma.artifactRenderError.findFirst({ where: { organizationId: scope.organizationId, artifactId: scope.artifactId, versionId }, orderBy: { createdAt: 'desc' } })
  if (!row) return null
  const parsed = z.array(renderErrorSchema).safeParse(row.errors)
  if (!parsed.success || !parsed.data.length) return null
  return { versionId: row.versionId, errors: parsed.data, reportedAt: row.createdAt.toISOString(), reportedByUserId: row.userId }
}

/** One line per error, for a prompt or a banner. */
export function describeRenderErrors(report: RenderErrorReport): string[] {
  return report.errors.map((error) => `${error.message}${error.count && error.count > 1 ? ` (×${error.count})` : ''}`)
}
