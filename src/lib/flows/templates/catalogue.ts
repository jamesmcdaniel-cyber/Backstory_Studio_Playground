import type { FlowTemplate } from '@prisma/client'
import { prisma, systemPrisma } from '@/lib/prisma'
import { flowGraphSchema, emptyGraph, type FlowGraph } from '@/lib/flows/graph'
import { triggerFromGraph } from '@/lib/flows/trigger'
import { BUILTIN_FLOW_TEMPLATES } from '@/lib/flows/templates/builtin'
import {
  flowTemplateBindingSchema,
  flowTemplateNotesSchema,
  isExecutableNode,
  type FlowTemplateBinding,
  type FlowTemplateDef,
  type FlowTemplateNotes,
  type SerializedFlowTemplate,
} from '@/lib/flows/templates/types'

/**
 * Reading the flow-template catalogue: the org's own rows (any visibility),
 * other orgs' published community rows, then the built-ins. Scoping and
 * ranking mirror `src/lib/templates/catalogue.ts` so the two galleries behave
 * identically — the only cross-org read is the public global slice.
 */

const EMPTY_NOTES: FlowTemplateNotes = { objective: '', inputs: [], steps: [], setup: [], customize: [] }

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** Count the steps a card shows — executable nodes only, so notes don't inflate it. */
export function stepCountOf(graph: FlowGraph): number {
  return graph.nodes.filter(isExecutableNode).length
}

/** Tolerant parse: a malformed stored blob degrades to empty rather than 500ing the gallery. */
function safeNotes(value: unknown): FlowTemplateNotes {
  const parsed = flowTemplateNotesSchema.safeParse(value)
  return parsed.success ? parsed.data : EMPTY_NOTES
}

function safeBindings(value: unknown): FlowTemplateBinding[] {
  const parsed = flowTemplateBindingSchema.array().safeParse(value)
  return parsed.success ? parsed.data : []
}

function safeGraph(value: unknown): FlowGraph {
  const parsed = flowGraphSchema.safeParse(value)
  return parsed.success ? parsed.data : emptyGraph()
}

/** Serialize a stored row for the API. `mine` gates edit/delete in the UI. */
export function serializeFlowTemplate(row: FlowTemplate, viewerOrgId?: string): SerializedFlowTemplate {
  const config = asObject(row.configuration)
  const graph = safeGraph(row.graph)
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    category: row.category,
    graph,
    trigger: row.trigger ?? triggerFromGraph(graph),
    notes: safeNotes(row.notes),
    bindings: safeBindings(row.bindings),
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

/** The full catalogue for a viewer: stored rows ranked own-first, then built-ins. */
export async function listFlowTemplateCatalogue(organizationId: string): Promise<SerializedFlowTemplate[]> {
  const { own, global } = await fetchFlowTemplateRows(organizationId)
  const stored = sortStoredFlowTemplates([...own, ...global], organizationId).map((row) =>
    serializeFlowTemplate(row, organizationId),
  )
  return [...stored, ...BUILTIN_FLOW_TEMPLATES.map(serializeBuiltinFlowTemplate)]
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
  return row ? serializeFlowTemplate(row, organizationId) : null
}
