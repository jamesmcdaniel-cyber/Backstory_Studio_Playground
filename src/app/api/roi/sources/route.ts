import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { listRoiSources, tagRoiSource, isRoiSourceKind } from '@/lib/roi/sources'

export const runtime = 'nodejs'

// GET /api/roi/sources — accounts with extracts loaded in the repository, and which extracts each has.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  return { success: true, sources: await listRoiSources(auth.organizationId) }
}, { permission: 'agent.read', internalOnly: true })

// POST /api/roi/sources — tag a repository dataset as an account's extract
// (operator action; the seed script and the Databricks flow write the same tag).
export const POST = withAuthenticatedApi(async (request, auth) => {
  const parsed = z.object({ documentId: z.string().min(1), account: z.string().trim().min(1).max(200), kind: z.string().refine(isRoiSourceKind, 'Unknown extract kind.') })
    .safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw new ApiError(parsed.error.issues[0]?.message ?? 'Send documentId, account and kind.', 400, 'INVALID_BODY')
  try {
    await tagRoiSource({ organizationId: auth.organizationId, documentId: parsed.data.documentId, account: parsed.data.account, kind: parsed.data.kind })
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : 'Could not tag the dataset.', 404, 'NOT_FOUND')
  }
  return { success: true }
}, { permission: 'platform.administer', internalOnly: true })
