import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { credentialDependents } from '@/lib/credentials/lookup-dependents'
import { describeDependents } from '@/lib/credentials/dependents'

export const runtime = 'nodejs'

const query = z.object({
  kind: z.enum(['mcp_connection', 'http_credential', 'nango']),
  ref: z.string().min(1).max(200),
})

/**
 * What stops working if this credential goes away.
 *
 * The audit trail answers "who used this" after the fact; this answers it
 * before, which is the difference between revoking a connection and finding out
 * at 6am when a published flow fails on its schedule.
 *
 * Read-only and scoped to the caller's workspace, so it can be called freely
 * from a confirmation dialog without a mutation of its own.
 */
export const GET = withAuthenticatedApi(async (request, auth) => {
  const url = request.nextUrl.searchParams
  const parsed = query.safeParse({ kind: url.get('kind'), ref: url.get('ref') })
  if (!parsed.success) throw new ApiError('A credential kind and reference are required.', 400, 'INVALID_REQUEST')

  const ref =
    parsed.data.kind === 'nango'
      ? ({ kind: 'nango', connectorKey: parsed.data.ref } as const)
      : ({ kind: parsed.data.kind, id: parsed.data.ref } as const)

  const dependents = await credentialDependents(auth.organizationId, ref)
  return { success: true, dependents, summary: describeDependents(dependents) }
}, { permission: 'integration.manage' })
