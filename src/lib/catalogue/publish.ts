/**
 * Publishing an approved submission.
 *
 * The published entry is an ORDINARY template row owned by the Backstory
 * internal org, with visibility 'global'. No separate catalogue table exists:
 * every read path (fetchCatalogueRows, fetchFlowTemplateRows, the skills
 * library) already understands 'global', so publishing needs no new reader and
 * staff can edit a published entry like any other row.
 */
import { prisma, systemPrisma } from '@/lib/prisma'
import { createTemplate } from '@/lib/templates/create-template'
import { createFlowTemplate } from '@/lib/flows/templates/create'
import type { SubmissionKind } from './submissions'

/**
 * The org that owns published catalogue entries. Misconfiguration here is loud
 * on purpose — a silent fallback would publish into someone's workspace.
 */
export async function resolveInternalOrgId(): Promise<string> {
  // systemPrisma: resolving the platform's own tenant is org-less by nature.
  const org = await systemPrisma.organization.findFirst({
    where: { kind: 'internal' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  if (!org) {
    throw new Error(
      'No internal organization exists to own catalogue entries. Set PLATFORM_STAFF_EMAILS and sign in as a listed address to mark one.',
    )
  }
  return org.id
}

export interface PublishParams {
  submissionId: string
  reviewerUserId: string
  internalOrgId: string
}

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback

/** Write an approved snapshot into the catalogue. Returns the new entry's id. */
export async function publishSubmission(params: PublishParams): Promise<{ publishedEntryId: string }> {
  // systemPrisma: the reviewer's org is the INTERNAL org, not the submitting
  // one, so this read crosses tenants by design — it is the review queue.
  const submission = await systemPrisma.catalogueSubmission.findUnique({
    where: { id: params.submissionId },
  })
  if (!submission) throw new Error('That submission no longer exists.')

  const snapshot = submission.snapshot as Record<string, unknown>
  const kind = submission.kind as SubmissionKind

  if (kind === 'agent_template') {
    const entry = await createTemplate({
      organizationId: params.internalOrgId,
      // The APPROVING REVIEWER owns the entry: they are accountable for what
      // the catalogue serves. Author attribution rides in configuration.authorName.
      userId: params.reviewerUserId,
      name: asString(snapshot.name, submission.title),
      description: asString(snapshot.description),
      category: asString(snapshot.type, 'Custom'),
      configuration: (snapshot.configuration ?? {}) as Record<string, unknown>,
      visibility: 'global',
    })
    await prisma.agentTemplate.update({
      where: { id: entry.id, organizationId: params.internalOrgId },
      data: { catalogueStatus: 'published' },
    })
    return { publishedEntryId: entry.id }
  }

  if (kind === 'flow_template') {
    const configuration = (snapshot.configuration ?? {}) as Record<string, unknown>
    const entry = await createFlowTemplate({
      organizationId: params.internalOrgId,
      userId: params.reviewerUserId,
      name: asString(snapshot.name, submission.title),
      description: asString(snapshot.description),
      category: asString(snapshot.category, 'Custom'),
      graph: snapshot.graph as never,
      notes: snapshot.notes as never,
      bindings: (snapshot.bindings ?? []) as never,
      integrations: (configuration.integrations ?? []) as string[],
      tags: (configuration.tags ?? []) as string[],
      icon: typeof configuration.icon === 'string' ? configuration.icon : undefined,
      exampleOutput: typeof configuration.exampleOutput === 'string' ? configuration.exampleOutput : undefined,
      authorName: asString(configuration.authorName),
      visibility: 'global',
    })
    await prisma.flowTemplate.update({
      where: { id: entry.id, organizationId: params.internalOrgId },
      data: { catalogueStatus: 'published' },
    })
    return { publishedEntryId: entry.id }
  }

  const entry = await prisma.sharedSkill.create({
    data: {
      name: asString(snapshot.name, submission.title),
      description: asString(snapshot.description),
      category: asString(snapshot.category, 'Community'),
      instructions: asString(snapshot.instructions),
      tags: (snapshot.tags ?? []) as never,
      integrations: (snapshot.integrations ?? []) as never,
      authorName: asString(snapshot.authorName),
      organizationId: params.internalOrgId,
      userId: params.reviewerUserId,
      visibility: 'global',
      catalogueStatus: 'published',
    },
  })
  return { publishedEntryId: entry.id }
}
