/**
 * Catalogue submissions: an author's request to publish into the shared
 * catalogue, and the frozen snapshot a reviewer decides on.
 *
 * The snapshot is the point of this module. Reviewing a LIVE row would let an
 * author edit an entry after approval and have the change land in every
 * workspace unreviewed; freezing a copy at submit time makes what was reviewed
 * and what gets published the same bytes.
 */
import { prisma } from '@/lib/prisma'
import { findSecretCandidates, stripOrgReferences } from '@/lib/catalogue/sanitize'
import type { CatalogueSubmission } from '@prisma/client'

export type SubmissionKind = 'flow_template' | 'agent_template' | 'shared_skill'

export const SUBMISSION_KINDS: readonly SubmissionKind[] = ['flow_template', 'agent_template', 'shared_skill']

/**
 * The fields carried into a published entry, per kind. Tenancy and identity
 * columns (id, organizationId, userId, visibility, catalogueStatus, timestamps)
 * are deliberately absent — they belong to the author's row, and the published
 * entry gets its own.
 */
const SNAPSHOT_FIELDS: Record<SubmissionKind, readonly string[]> = {
  flow_template: ['name', 'description', 'category', 'graph', 'trigger', 'notes', 'bindings', 'configuration'],
  agent_template: ['name', 'description', 'type', 'configuration', 'schedule', 'priority', 'metadata'],
  shared_skill: ['name', 'description', 'category', 'instructions', 'tags', 'integrations', 'authorName'],
}

/** Freeze the publishable fields of `row` for review. Pure. */
export function buildSnapshot(kind: SubmissionKind, row: Record<string, unknown>): Record<string, unknown> {
  const fields = SNAPSHOT_FIELDS[kind]
  if (!fields) throw new Error(`Unknown catalogue kind: ${kind}`)
  const snapshot: Record<string, unknown> = {}
  for (const field of fields) {
    if (row[field] !== undefined && row[field] !== null) snapshot[field] = row[field]
  }
  return snapshot
}

export interface CreateSubmissionParams {
  organizationId: string
  userId: string
  kind: SubmissionKind
  sourceId: string
  title: string
  summary: string
}

/** Thrown when the source row does not resolve inside the caller's workspace. */
export class SourceNotFoundError extends Error {
  constructor() {
    super('That item no longer exists in your workspace.')
    this.name = 'SourceNotFoundError'
  }
}

/**
 * Snapshot the author's row and open a pending submission. The source read is
 * org-scoped, so another workspace's row simply does not resolve — the caller
 * turns that into a 404 rather than a 403, which would confirm it exists.
 */
export async function createSubmission(params: CreateSubmissionParams): Promise<CatalogueSubmission> {
  const source = await loadSource(params.kind, params.sourceId, params.organizationId)
  if (!source) throw new SourceNotFoundError()

  // Sanitize BEFORE persisting, not at publish: the reviewer must read the
  // same bytes that get published, which is the reason the snapshot is frozen
  // here in the first place. Ids that only resolve in the author's workspace
  // are dropped; literal credentials are reported for the reviewer to judge.
  const snapshot = stripOrgReferences(buildSnapshot(params.kind, source))
  const warnings = findSecretCandidates(snapshot)

  return prisma.catalogueSubmission.create({
    data: {
      kind: params.kind,
      title: params.title,
      summary: params.summary,
      snapshot: snapshot as never,
      warnings: warnings.length > 0 ? (warnings as never) : undefined,
      sourceId: params.sourceId,
      organizationId: params.organizationId,
      submittedByUserId: params.userId,
    },
  })
}

async function loadSource(
  kind: SubmissionKind,
  id: string,
  organizationId: string,
): Promise<Record<string, unknown> | null> {
  const where = { id, organizationId, isActive: true }
  if (kind === 'flow_template') return prisma.flowTemplate.findFirst({ where }) as never
  if (kind === 'agent_template') return prisma.agentTemplate.findFirst({ where }) as never
  return prisma.sharedSkill.findFirst({ where }) as never
}
