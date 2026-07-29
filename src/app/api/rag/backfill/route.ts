import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { backfillOrganization } from '@/lib/rag/backfill'

export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * Admin-only, org-scoped graph-RAG backfill: seeds the graph from the org's
 * Sales AI book (top_records, enriched) plus existing agents/runs/signals.
 * Idempotent and re-runnable.
 */
export const POST = withAuthenticatedApi(async (_request, auth) => {
  if (auth.dbUser.role !== 'ADMIN') throw new ApiError('Admin access required', 403, 'FORBIDDEN')
  const result = await backfillOrganization(auth.organizationId)
  return { success: true, result }
}, { permission: 'org.manage' })
