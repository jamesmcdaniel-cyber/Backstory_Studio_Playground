import type { FlowTemplate, Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'

/**
 * Flow-template versioning: every content edit first snapshots the CURRENT
 * payload under the current version number, then applies the change with
 * version + 1 — so the history is "what the template looked like before each
 * edit", and restoring version N reproduces the template exactly as it was
 * when version N was live. Snapshot + bump run in one transaction: a snapshot
 * without its edit (or vice versa) would make the history lie.
 */

/** The restorable payload — the full content surface of a template row. */
export type FlowTemplateSnapshot = {
  name: string
  description: string | null
  category: string
  graph: unknown
  trigger: unknown
  notes: unknown
  bindings: unknown
  configuration: unknown
}

export function snapshotOfTemplate(row: FlowTemplate): FlowTemplateSnapshot {
  return {
    name: row.name,
    description: row.description,
    category: row.category,
    graph: row.graph,
    trigger: row.trigger,
    notes: row.notes,
    bindings: row.bindings,
    configuration: row.configuration,
  }
}

function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

/**
 * Snapshot `existing` then apply `data` with the version bump, atomically.
 * `data` is the plain Prisma update payload the caller already built — this
 * wrapper only adds the history write and the version increment.
 */
export async function updateFlowTemplateVersioned(
  existing: FlowTemplate,
  data: Prisma.FlowTemplateUpdateInput,
  savedBy: string,
): Promise<FlowTemplate> {
  const [, updated] = await prisma.$transaction([
    prisma.flowTemplateVersion.create({
      data: {
        templateId: existing.id,
        organizationId: existing.organizationId,
        version: existing.version,
        snapshot: jsonValue(snapshotOfTemplate(existing)),
        savedBy,
      },
    }),
    prisma.flowTemplate.update({
      where: { id: existing.id, organizationId: existing.organizationId },
      data: { ...data, version: existing.version + 1 },
    }),
  ])
  return updated
}

/**
 * Restore version N: snapshot the current payload (so the restore itself is
 * undoable), then overwrite the row with the stored snapshot. Returns null
 * when the version doesn't exist for this template/org.
 */
export async function restoreFlowTemplateVersion(
  existing: FlowTemplate,
  version: number,
  savedBy: string,
): Promise<FlowTemplate | null> {
  const stored = await prisma.flowTemplateVersion.findFirst({
    where: { templateId: existing.id, organizationId: existing.organizationId, version },
  })
  if (!stored) return null
  const snap = stored.snapshot as FlowTemplateSnapshot
  return updateFlowTemplateVersioned(
    existing,
    {
      name: snap.name,
      description: snap.description,
      category: snap.category,
      graph: jsonValue(snap.graph),
      trigger: jsonValue(snap.trigger),
      notes: jsonValue(snap.notes),
      bindings: jsonValue(snap.bindings),
      configuration: jsonValue(snap.configuration),
    },
    savedBy,
  )
}
