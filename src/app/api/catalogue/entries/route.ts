import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { resolveInternalOrgId } from '@/lib/catalogue/publish'

/**
 * Catalogue entries staff manage: `published` (approved through review) and
 * `legacy_published` (global before review existed, pending audit).
 *
 * Published entries live in the internal org, so this read is org-scoped like
 * any other — the queue at /api/catalogue/review is the only cross-tenant one.
 * Legacy rows are the exception: they sit in whichever workspace authored them
 * back when anyone could publish, which is exactly why they need auditing.
 */
export const GET = withAuthenticatedApi(async (request) => {
  const status = request.nextUrl.searchParams.get('status') === 'legacy_published'
    ? 'legacy_published'
    : 'published'

  if (status === 'published') {
    const internalOrgId = await resolveInternalOrgId()
    const where = { organizationId: internalOrgId, catalogueStatus: 'published', isActive: true }
    const [agentTemplates, flowTemplates, skills] = await Promise.all([
      prisma.agentTemplate.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 200 }),
      prisma.flowTemplate.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 200 }),
      prisma.sharedSkill.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 200 }),
    ])
    return { success: true, entries: serialize(agentTemplates, flowTemplates, skills) }
  }

  // systemPrisma: legacy rows are spread across the workspaces that published
  // them before the gate existed; auditing them is the whole point of this tab.
  const { systemPrisma } = await import('@/lib/prisma')
  const where = { catalogueStatus: 'legacy_published', isActive: true }
  const [agentTemplates, flowTemplates, skills] = await Promise.all([
    systemPrisma.agentTemplate.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 200 }),
    systemPrisma.flowTemplate.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 200 }),
    systemPrisma.sharedSkill.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 200 }),
  ])
  return { success: true, entries: serialize(agentTemplates, flowTemplates, skills) }
}, { permission: 'catalogue.review', internalOnly: true })

type Row = { id: string; name: string; organizationId: string; updatedAt: Date }

function serialize(agentTemplates: Row[], flowTemplates: Row[], skills: Row[]) {
  return [
    ...agentTemplates.map((row) => ({ ...pick(row), kind: 'agent_template' })),
    ...flowTemplates.map((row) => ({ ...pick(row), kind: 'flow_template' })),
    ...skills.map((row) => ({ ...pick(row), kind: 'shared_skill' })),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

const pick = (row: Row) => ({
  id: row.id,
  name: row.name,
  organizationId: row.organizationId,
  updatedAt: row.updatedAt.toISOString(),
})
