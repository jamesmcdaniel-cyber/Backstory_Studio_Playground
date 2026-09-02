/**
 * Collections: named sets of repository assets, attachable to many agents.
 *
 * Deleting a collection removes the grouping, never the documents — the join
 * rows cascade, the assets do not. That asymmetry is deliberate: a collection
 * is a label, and deleting a label must not destroy what it labelled.
 */

import { prisma } from '@/lib/prisma'
import { assertRepositoryAgentScope } from './repository'

export class CollectionNotFoundError extends Error {}

const cleanName = (value: string) => value.replace(/[\r\n]/g, ' ').trim().slice(0, 120)

export async function listCollections(params: { organizationId: string }) {
  const rows = await prisma.knowledgeCollection.findMany({
    where: { organizationId: params.organizationId },
    orderBy: { name: 'asc' },
    include: { _count: { select: { documents: true, agents: true } } },
  })
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    documentCount: row._count.documents,
    agentCount: row._count.agents,
    updatedAt: row.updatedAt,
  }))
}

export async function createCollection(params: { organizationId: string; name: string; description?: string }) {
  const name = cleanName(params.name)
  if (!name) throw new CollectionNotFoundError('A collection needs a name.')
  return prisma.knowledgeCollection.create({
    data: {
      organizationId: params.organizationId,
      name,
      description: (params.description ?? '').trim().slice(0, 2_000),
    },
  })
}

export async function renameCollection(params: {
  organizationId: string
  id: string
  name?: string
  description?: string
}) {
  const updated = await prisma.knowledgeCollection.updateMany({
    where: { id: params.id, organizationId: params.organizationId },
    data: {
      ...(params.name !== undefined ? { name: cleanName(params.name) } : {}),
      ...(params.description !== undefined ? { description: params.description.trim().slice(0, 2_000) } : {}),
    },
  })
  if (updated.count !== 1) throw new CollectionNotFoundError('Collection not found.')
  return prisma.knowledgeCollection.findFirst({ where: { id: params.id, organizationId: params.organizationId } })
}

export async function deleteCollection(params: { organizationId: string; id: string }) {
  const deleted = await prisma.knowledgeCollection.deleteMany({
    where: { id: params.id, organizationId: params.organizationId },
  })
  if (deleted.count !== 1) throw new CollectionNotFoundError('Collection not found.')
  return { id: params.id }
}

/**
 * Replace a document's collection membership wholesale. Idempotent, and ids
 * from another workspace are silently dropped rather than attached — the
 * validity check is what makes a client-supplied id list safe to accept.
 */
export async function setDocumentCollections(params: {
  organizationId: string
  documentId: string
  collectionIds: string[]
}) {
  const valid = await prisma.knowledgeCollection.findMany({
    where: { organizationId: params.organizationId, id: { in: params.collectionIds } },
    select: { id: true },
  })
  await prisma.$transaction([
    prisma.knowledgeDocumentCollection.deleteMany({
      where: { documentId: params.documentId, organizationId: params.organizationId },
    }),
    prisma.knowledgeDocumentCollection.createMany({
      data: valid.map((collection) => ({
        documentId: params.documentId,
        collectionId: collection.id,
        organizationId: params.organizationId,
      })),
      skipDuplicates: true,
    }),
  ])
  return valid.map((collection) => collection.id)
}

/** Replace an agent's attached collections wholesale. Idempotent. */
export async function setAgentCollections(params: {
  organizationId: string
  userId: string
  agentId: string
  collectionIds: string[]
}) {
  // Reuses the repository's agent-visibility check: you cannot attach a
  // collection to an agent you are not allowed to see.
  await assertRepositoryAgentScope({
    organizationId: params.organizationId,
    userId: params.userId,
    agentId: params.agentId,
  })
  const valid = await prisma.knowledgeCollection.findMany({
    where: { organizationId: params.organizationId, id: { in: params.collectionIds } },
    select: { id: true },
  })
  await prisma.$transaction([
    prisma.agentKnowledgeCollection.deleteMany({
      where: { agentId: params.agentId, organizationId: params.organizationId },
    }),
    prisma.agentKnowledgeCollection.createMany({
      data: valid.map((collection) => ({
        agentId: params.agentId,
        collectionId: collection.id,
        organizationId: params.organizationId,
      })),
      skipDuplicates: true,
    }),
  ])
  return valid.map((collection) => collection.id)
}

/** The collection ids attached to one agent, for the agent page's checkboxes. */
export async function listAgentCollections(params: { organizationId: string; agentId: string }) {
  const rows = await prisma.agentKnowledgeCollection.findMany({
    where: { organizationId: params.organizationId, agentId: params.agentId },
    select: { collectionId: true },
  })
  return rows.map((row) => row.collectionId)
}
