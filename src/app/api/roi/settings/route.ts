import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { ensureRoiAgent, findRoiAgent, setRoiDataFlow } from '@/lib/roi/agent'

export const runtime = 'nodejs'

// PATCH /api/roi/settings — connect (or disconnect) the flow that fetches an
// account's data for each run. Only the ROI Analyst's owner may change it;
// before the analyst exists, a workspace admin provisions it and becomes owner.
export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const parsed = z.object({ dataFlowId: z.string().min(1).nullable() }).safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw new ApiError('Send dataFlowId: a flow id, or null to use the loaded extracts.', 400, 'INVALID_BODY')
  const existing = await findRoiAgent(auth.organizationId)
  const isAdmin = auth.dbUser.role === 'ADMIN' || auth.dbUser.role === 'OWNER'
  if (existing ? existing.userId !== auth.dbUser.id : !isAdmin) {
    throw new ApiError('Only the ROI Analyst\'s owner can change where its data comes from.', 403, 'FORBIDDEN')
  }
  let flow: { id: string; name: string } | null = null
  if (parsed.data.dataFlowId) {
    flow = await prisma.flow.findFirst({ where: { id: parsed.data.dataFlowId, organizationId: auth.organizationId }, select: { id: true, name: true } })
    if (!flow) throw new ApiError('That flow is not in this workspace.', 404, 'NOT_FOUND')
  }
  const agent = existing ?? await ensureRoiAgent(auth.organizationId, auth.dbUser.id)
  await setRoiDataFlow(auth.organizationId, agent, flow?.id ?? null)
  return { success: true, dataSource: flow ? { kind: 'flow', flowId: flow.id, flowName: flow.name } : { kind: 'repository', flowId: null, flowName: null } }
}, { permission: 'agent.write', internalOnly: true })
