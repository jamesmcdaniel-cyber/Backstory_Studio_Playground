import type { AgentTemplate } from '@prisma/client'
import { z } from 'zod'
import { prisma, systemPrisma } from '@/lib/prisma'
import { enhanceAutomationInstructions } from '@/lib/templates/automation-assets'
import { apiLogger } from '@/lib/logger'

/** The subset of an AgentTemplate row the serializer reads (row from DB or a test fixture). */
export type AgentTemplateRow = Pick<AgentTemplate, 'id' | 'name' | 'type' | 'organizationId'> & {
  description?: string | null
  configuration?: unknown
  source?: string | null
  visibility?: string | null
}

export interface SerializedTemplate {
  id: string
  name: string
  description: string
  category: string
  instructions: string
  integrations: string[]
  skills: string[]
  tags: string[]
  model: string
  exampleOutput: string
  icon: string
  allowSubagents: boolean
  allowFlows: boolean
  alwaysStrategize: boolean
  requireApproval: boolean
  schedule?: {
    type: 'manual' | 'hourly' | 'daily' | 'weekly' | 'cron' | 'once'
    time?: string
    cron?: string
    timezone?: string
    runAt?: string
    isActive?: boolean
  }
  custom: boolean
  authorName: string
  source: string
  visibility: string
  mine: boolean
}

const storedAgentTemplateConfigSchema = z.object({
  instructions: z.string().min(1),
  integrations: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  model: z.string().min(1).default('gpt-4o'),
  exampleOutput: z.string().default(''),
  icon: z.string().default(''),
  allowSubagents: z.boolean().default(false),
  allowFlows: z.boolean().default(false),
  alwaysStrategize: z.boolean().default(false),
  requireApproval: z.boolean().default(false),
  schedule: z.object({
    type: z.enum(['manual', 'hourly', 'daily', 'weekly', 'cron', 'once']),
    time: z.string().optional(),
    cron: z.string().optional(),
    timezone: z.string().optional(),
    runAt: z.string().optional(),
    isActive: z.boolean().optional(),
  }).optional(),
  authorName: z.string().default(''),
})

/** Serialize a stored template row for the API. `mine` gates edit/delete in the UI. */
export function serializeTemplate(template: AgentTemplateRow, viewerOrgId?: string): SerializedTemplate {
  const config = storedAgentTemplateConfigSchema.parse(template.configuration)
  return {
    id: template.id,
    name: template.name,
    description: (template.description as string) || '',
    category: template.type,
    instructions: (template.source ?? 'user') === 'ai_generated'
      ? enhanceAutomationInstructions(config.instructions)
      : config.instructions,
    integrations: config.integrations,
    skills: config.skills,
    tags: config.tags,
    model: config.model,
    exampleOutput: config.exampleOutput,
    icon: config.icon,
    allowSubagents: config.allowSubagents === true,
    allowFlows: config.allowFlows === true,
    alwaysStrategize: config.alwaysStrategize === true,
    requireApproval: config.requireApproval === true,
    ...(config.schedule && typeof config.schedule === 'object' && !Array.isArray(config.schedule)
      ? { schedule: config.schedule as SerializedTemplate['schedule'] }
      : {}),
    custom: true,
    authorName: config.authorName,
    source: template.source ?? 'user',
    visibility: template.visibility ?? 'org',
    // Only the creating org may edit/delete a template.
    mine: Boolean(viewerOrgId) && template.organizationId === viewerOrgId,
  }
}

export type StoredTemplateRow = { organizationId: string; source?: string | null; visibility?: string | null; updatedAt: Date }

/**
 * Rank stored templates for a viewer: the org's own templates first
 * (ai_generated above user-authored), then other orgs' global community
 * templates. Newest-first within each group. Pure — no DB.
 */
export function sortStoredTemplates<T extends StoredTemplateRow>(rows: T[], viewerOrgId: string): T[] {
  const groupOf = (row: T): number => {
    const own = row.organizationId === viewerOrgId
    if (own && (row.source ?? 'user') === 'ai_generated') return 0
    if (own) return 1
    return 2 // other orgs' global community templates
  }
  return [...rows].sort((a, b) => {
    const ga = groupOf(a)
    const gb = groupOf(b)
    if (ga !== gb) return ga - gb
    return b.updatedAt.getTime() - a.updatedAt.getTime()
  })
}

/**
 * The catalogue rows for a viewer: their own templates (any visibility) via the
 * tenant-guarded client, plus OTHER orgs' global community templates. The only
 * cross-org read is the global slice.
 */
export async function fetchCatalogueRows(organizationId: string): Promise<{ own: AgentTemplate[]; global: AgentTemplate[] }> {
  // Cap the own slice like the global one below — a bound on the read, not a
  // product limit (orderBy keeps the most recent if an org ever exceeds it).
  const own = await prisma.agentTemplate.findMany({ where: { organizationId, isActive: true }, orderBy: { updatedAt: 'desc' }, take: 500 })
  // systemPrisma: cross-org read of the PUBLIC community slice only — global
  // templates from OTHER orgs. Own rows come from the tenant-guarded query above.
  const globalRows = await systemPrisma.agentTemplate.findMany({
    where: { isActive: true, visibility: 'global', NOT: { organizationId } },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  })
  return { own, global: globalRows }
}

/** Own + global community templates, ranked own-first, serialized. */
export async function listStoredCatalogue(organizationId: string): Promise<SerializedTemplate[]> {
  const { own, global } = await fetchCatalogueRows(organizationId)
  return sortStoredTemplates([...own, ...global], organizationId).flatMap((row) => {
    try {
      return [serializeTemplate(row, organizationId)]
    } catch (error) {
      apiLogger.error('agent-template catalogue: quarantining malformed row', {
        organizationId,
        templateId: row.id,
        error: error instanceof Error ? error.message : String(error),
      })
      return []
    }
  })
}
