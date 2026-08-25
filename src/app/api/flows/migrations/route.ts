import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { recordAudit } from '@/lib/audit'
import { flowGraphSchema } from '@/lib/flows/graph'
import { CURRENT_GRAPH_VERSION, describeGraphMigration, migrateGraphShape } from '@/lib/flows/graph-migrations'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

type StoredGraph = {
  kind: 'draft' | 'published' | 'template' | 'review' | 'version' | 'snapshot'
  id: string
  ownerId?: string
  graph: unknown
}

function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

async function storedGraphs(organizationId: string): Promise<StoredGraph[]> {
  const [flows, templates, reviews, versions, snapshots] = await Promise.all([
    prisma.flow.findMany({
      where: { organizationId },
      select: { id: true, graph: true, publishedGraph: true },
    }),
    prisma.flowTemplate.findMany({ where: { organizationId }, select: { id: true, graph: true } }),
    prisma.flowReview.findMany({ where: { organizationId }, select: { id: true, flowId: true, graph: true } }),
    prisma.flowVersion.findMany({ where: { organizationId }, select: { id: true, flowId: true, graph: true } }),
    prisma.flowEditSnapshot.findMany({ where: { organizationId }, select: { id: true, flowId: true, graph: true } }),
  ])
  return [
    ...flows.flatMap((flow): StoredGraph[] => [
      { kind: 'draft', id: flow.id, graph: flow.graph },
      ...(flow.publishedGraph == null ? [] : [{ kind: 'published' as const, id: flow.id, graph: flow.publishedGraph }]),
    ]),
    ...templates.map((row): StoredGraph => ({ kind: 'template', id: row.id, graph: row.graph })),
    ...reviews.map((row): StoredGraph => ({ kind: 'review', id: row.id, ownerId: row.flowId, graph: row.graph })),
    ...versions.map((row): StoredGraph => ({ kind: 'version', id: row.id, ownerId: row.flowId, graph: row.graph })),
    ...snapshots.map((row): StoredGraph => ({ kind: 'snapshot', id: row.id, ownerId: row.flowId, graph: row.graph })),
  ]
}

function report(rows: StoredGraph[]) {
  const entries = rows.map((row) => ({ ...row, graph: undefined, ...describeGraphMigration(row.graph) }))
  return {
    currentVersion: CURRENT_GRAPH_VERSION,
    total: entries.length,
    current: entries.filter((entry) => entry.current).length,
    pending: entries.filter((entry) => !entry.current && !entry.future).length,
    future: entries.filter((entry) => entry.future).length,
    entries: entries.filter((entry) => !entry.current),
  }
}

export const GET = withAuthenticatedApi(async (_request, auth) => ({
  success: true,
  report: report(await storedGraphs(auth.organizationId)),
}), { permission: 'flow.read' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { apply } = z.object({ apply: z.literal(true) }).parse(await request.json())
  if (!apply) throw new ApiError('Set apply=true to migrate stored graphs.', 400, 'MIGRATION_CONFIRMATION_REQUIRED')

  const rows = await storedGraphs(auth.organizationId)
  const failures: Array<{ kind: StoredGraph['kind']; id: string; error: string }> = []
  let migrated = 0

  for (const row of rows) {
    const state = describeGraphMigration(row.graph)
    if (state.current) continue
    if (state.future) {
      failures.push({ kind: row.kind, id: row.id, error: `Graph is from future schema v${state.version}.` })
      continue
    }
    const parsed = flowGraphSchema.safeParse(migrateGraphShape(row.graph))
    if (!parsed.success) {
      failures.push({ kind: row.kind, id: row.id, error: parsed.error.issues[0]?.message ?? 'Graph validation failed.' })
      continue
    }
    const graph = jsonValue(parsed.data)
    switch (row.kind) {
      case 'draft':
        await prisma.flow.updateMany({ where: { id: row.id, organizationId: auth.organizationId }, data: { graph } })
        break
      case 'published':
        await prisma.flow.updateMany({ where: { id: row.id, organizationId: auth.organizationId }, data: { publishedGraph: graph } })
        break
      case 'template':
        await prisma.flowTemplate.updateMany({ where: { id: row.id, organizationId: auth.organizationId }, data: { graph } })
        break
      case 'review':
        await prisma.flowReview.updateMany({ where: { id: row.id, organizationId: auth.organizationId }, data: { graph } })
        break
      case 'version':
        await prisma.flowVersion.updateMany({ where: { id: row.id, organizationId: auth.organizationId }, data: { graph } })
        break
      case 'snapshot':
        await prisma.flowEditSnapshot.updateMany({ where: { id: row.id, organizationId: auth.organizationId }, data: { graph } })
        break
    }
    migrated += 1
  }

  await recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    action: 'flow.graphs_migrated',
    resourceType: 'flow',
    detail: { targetVersion: CURRENT_GRAPH_VERSION, migrated, failures: failures.length },
  }).catch(() => undefined)

  return { success: failures.length === 0, migrated, failures, report: report(await storedGraphs(auth.organizationId)) }
}, { permission: 'flow.write' })
