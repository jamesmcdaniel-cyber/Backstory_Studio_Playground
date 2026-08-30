import type { FlowTemplate } from '@prisma/client'
import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { flowGraphSchema, stepCountOf } from '@/lib/flows/graph'
import { triggerFromGraph } from '@/lib/flows/trigger'
import { validateFlowGraph } from '@/lib/flows/validate'
import { BUILTIN_FLOW_TEMPLATES } from '@/lib/flows/templates/builtin'
import {
  flowTemplateBindingSchema,
  flowTemplateNotesIssues,
  flowTemplateNotesSchema,
  type FlowTemplateDef,
  type SerializedFlowTemplate,
} from '@/lib/flows/templates/types'

/**
 * Reading the flow-template catalogue: the org's own rows (any visibility),
 * other orgs' published community rows, then the built-ins. Scoping and
 * ranking mirror `src/lib/templates/catalogue.ts` so the two galleries behave
 * identically — the only cross-org read is the public global slice.
 */

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** Count the steps a card shows — re-exported so existing importers are unchanged. */
export { stepCountOf } from '@/lib/flows/graph'

/**
 * Serialize a stored row for the API. Invalid executable blobs throw: callers
 * quarantine the row instead of advertising an empty, "importable" flow that
 * can never do what its Details page promises.
 */
export function serializeFlowTemplate(row: FlowTemplate, viewerOrgId?: string): SerializedFlowTemplate {
  const config = asObject(row.configuration)
  const graph = flowGraphSchema.parse(row.graph)
  const notes = flowTemplateNotesSchema.parse(row.notes)
  const bindings = flowTemplateBindingSchema.array().parse(row.bindings)
  const notesIssues = flowTemplateNotesIssues(graph, notes, bindings)
  if (notesIssues.length) throw new Error(notesIssues.join(' | '))
  const boundNodes = new Set(bindings.map((binding) => binding.nodeId))
  const graphErrors = validateFlowGraph(graph, { requireRunnable: true }).errors.filter(
    (error) => !error.nodeId || !boundNodes.has(error.nodeId),
  )
  if (graphErrors.length) throw new Error(graphErrors.map((error) => error.message).join(' | '))
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    category: row.category,
    graph,
    trigger: row.trigger ?? triggerFromGraph(graph),
    notes,
    bindings,
    integrations: Array.isArray(config.integrations) ? (config.integrations as string[]) : [],
    tags: Array.isArray(config.tags) ? (config.tags as string[]) : [],
    icon: typeof config.icon === 'string' ? config.icon : '',
    exampleOutput: typeof config.exampleOutput === 'string' ? config.exampleOutput : '',
    authorName: typeof config.authorName === 'string' ? config.authorName : '',
    stepCount: stepCountOf(graph),
    custom: true,
    source: row.source,
    visibility: row.visibility,
    mine: Boolean(viewerOrgId) && row.organizationId === viewerOrgId,
    version: row.version,
  }
}

/** Serialize a built-in. `custom: false` — there is no row to edit or delete. */
export function serializeBuiltinFlowTemplate(def: FlowTemplateDef): SerializedFlowTemplate {
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    category: def.category,
    graph: def.graph,
    trigger: triggerFromGraph(def.graph),
    notes: def.notes,
    bindings: def.bindings,
    integrations: def.integrations,
    tags: def.tags,
    icon: def.icon,
    exampleOutput: def.exampleOutput ?? '',
    authorName: '',
    stepCount: stepCountOf(def.graph),
    custom: false,
    source: 'builtin',
    visibility: 'global',
    mine: false,
    version: 1,
  }
}

export type StoredFlowTemplateRow = { organizationId: string; source: string; updatedAt: Date }

/**
 * Rank stored templates for a viewer: the org's own first (ai_generated above
 * hand-authored), then other orgs' community templates. Newest-first within
 * each group. Pure — no DB.
 */
export function sortStoredFlowTemplates<T extends StoredFlowTemplateRow>(rows: T[], viewerOrgId: string): T[] {
  const groupOf = (row: T): number => {
    const own = row.organizationId === viewerOrgId
    if (own && row.source === 'ai_generated') return 0
    if (own) return 1
    return 2
  }
  return [...rows].sort((a, b) => {
    const ga = groupOf(a)
    const gb = groupOf(b)
    return ga !== gb ? ga - gb : b.updatedAt.getTime() - a.updatedAt.getTime()
  })
}

/**
 * The org's own rows (any visibility) via the tenant-guarded client, plus OTHER
 * orgs' published community rows. The global slice is the only cross-org read.
 */
export async function fetchFlowTemplateRows(organizationId: string): Promise<{ own: FlowTemplate[]; global: FlowTemplate[] }> {
  const own = await prisma.flowTemplate.findMany({
    where: { organizationId, isActive: true },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  })
  // systemPrisma: cross-org read of the PUBLIC community slice only. Own rows
  // come from the tenant-guarded query above.
  const global = await systemPrisma.flowTemplate.findMany({
    where: { isActive: true, visibility: 'global', NOT: { organizationId } },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  })
  return { own, global }
}

/**
 * The full catalogue for a viewer: stored rows ranked own-first, then built-ins.
 *
 * The built-ins are code, not data — they need no database. So a failed stored-
 * row read (the table not migrated yet on a fresh environment, a transient
 * connection error) degrades to the built-in catalogue rather than 500ing the
 * endpoint, which would leave every template surface silently empty.
 */
export async function listFlowTemplateCatalogue(organizationId: string): Promise<SerializedFlowTemplate[]> {
  const builtins = BUILTIN_FLOW_TEMPLATES.map(serializeBuiltinFlowTemplate)
  try {
    const { own, global } = await fetchFlowTemplateRows(organizationId)
    const stored = sortStoredFlowTemplates([...own, ...global], organizationId).flatMap((row) => {
      try {
        return [serializeFlowTemplate(row, organizationId)]
      } catch (error) {
        apiLogger.error('flow-template catalogue: quarantining malformed row', {
          organizationId,
          templateId: row.id,
          error: error instanceof Error ? error.message : String(error),
        })
        return []
      }
    })
    return [...stored, ...builtins]
  } catch (error) {
    apiLogger.error('flow-template catalogue: stored rows unavailable, serving built-ins only', {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
    return builtins
  }
}

/**
 * One template by id, from either source. Stored rows are readable when the
 * viewer owns them or they are published globally; built-ins always are.
 */
export async function findFlowTemplate(id: string, organizationId: string): Promise<SerializedFlowTemplate | null> {
  const builtin = BUILTIN_FLOW_TEMPLATES.find((template) => template.id === id)
  if (builtin) return serializeBuiltinFlowTemplate(builtin)
  // systemPrisma: a community template lives in another org by definition; the
  // visibility filter below IS the access boundary.
  const row = await systemPrisma.flowTemplate.findFirst({
    where: { id, isActive: true, OR: [{ organizationId }, { visibility: 'global' }] },
  })
  if (!row) return null
  try {
    return serializeFlowTemplate(row, organizationId)
  } catch (error) {
    apiLogger.error('flow-template catalogue: refusing malformed row', {
      organizationId,
      templateId: row.id,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
