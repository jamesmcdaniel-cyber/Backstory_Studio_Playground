import { prisma } from '@/lib/prisma'
import { backstoryMcpReady } from '@/lib/mcp/backstory-connection'
import { findRoiAgent, roiDataFlowIdOf } from './agent'
import { coversFor, listRoiSources } from './sources'
import { ROI_ASYNC_AFTER_SECONDS, ROI_EXPECTED_SECONDS } from './service'
import type { RoiPageSetup } from './types'

/**
 * What the ROI analysis page draws its form from: the accounts it can run,
 * the private admin agent behind it, where a run's data comes from, and
 * whether the analyst can reach the Backstory platform for this person.
 *
 * Only the analyst's owner configures it (it is private): before the first
 * run provisions it, any workspace admin may — they become its owner.
 */
export async function loadRoiPageSetup(params: { organizationId: string; userId: string; role: string; canWriteAgents: boolean }): Promise<RoiPageSetup> {
  const [sources, agent, backstory] = await Promise.all([
    listRoiSources(params.organizationId),
    findRoiAgent(params.organizationId),
    backstoryMcpReady(params.organizationId, params.userId).catch(() => false),
  ])
  const isAdmin = params.role === 'ADMIN' || params.role === 'OWNER'
  const canConfigure = params.canWriteAgents && (agent ? agent.userId === params.userId : isAdmin)
  const owner = agent?.userId ? await prisma.user.findFirst({ where: { id: agent.userId, organizationId: params.organizationId }, select: { name: true, email: true } }) : null
  const flowId = roiDataFlowIdOf(agent)
  const flow = flowId ? await prisma.flow.findFirst({ where: { id: flowId, organizationId: params.organizationId }, select: { id: true, name: true } }) : null
  const flows = canConfigure
    ? await prisma.flow.findMany({ where: { organizationId: params.organizationId, status: { not: 'DISABLED' } }, orderBy: { updatedAt: 'desc' }, take: 100, select: { id: true, name: true, publishedGraph: true } })
    : []
  const metadata = (agent?.metadata ?? {}) as { title?: unknown; model?: unknown }
  const accounts: RoiPageSetup['accounts'] = sources
    .filter((source) => source.templates.includes('standard'))
    .map((source) => {
      const kinds = Object.keys(source.datasets) as Array<keyof typeof source.datasets>
      const loaded = kinds.map((kind) => source.datasets[kind]?.loadedAt).filter((value): value is string => Boolean(value)).sort()
      return { account: source.account, extracts: kinds, covers: coversFor(kinds), loadedAt: loaded.at(-1) ?? null }
    })
  // With a data flow, accounts analysed before can run again without loaded
  // extracts — the flow fetches them. (New ones are typed on the page.)
  if (flow) {
    const known = new Set(accounts.map((entry) => entry.account.toLowerCase()))
    const previous = await prisma.roiAnalysis.findMany({ where: { organizationId: params.organizationId }, distinct: ['account'], orderBy: { createdAt: 'desc' }, take: 200, select: { account: true } })
    for (const row of previous) {
      if (known.has(row.account.toLowerCase())) continue
      known.add(row.account.toLowerCase())
      accounts.push({ account: row.account, extracts: [], covers: [], loadedAt: null })
    }
    accounts.sort((a, b) => a.account.localeCompare(b.account))
  }
  return {
    accounts,
    agent: {
      id: agent?.id ?? null,
      title: typeof metadata.title === 'string' && metadata.title ? metadata.title : 'ROI Analyst',
      model: typeof metadata.model === 'string' ? metadata.model : null,
      canConfigure,
      ownerName: owner ? owner.name?.trim() || owner.email || null : null,
    },
    dataSource: flow ? { kind: 'flow', flowId: flow.id, flowName: flow.name } : { kind: 'repository', flowId: null, flowName: null },
    flows: flows.map((row) => ({ id: row.id, name: row.name, published: Boolean(row.publishedGraph) })),
    backstory: { connected: backstory },
    expectedSeconds: ROI_EXPECTED_SECONDS,
    asyncAfterSeconds: ROI_ASYNC_AFTER_SECONDS,
  }
}
