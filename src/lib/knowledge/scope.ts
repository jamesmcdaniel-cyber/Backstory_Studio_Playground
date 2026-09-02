/**
 * Which repository assets an agent may retrieve, expressed once.
 *
 * Three ways an asset reaches an agent: bound to it directly (`agentId`),
 * shared with the whole workspace (`agentId IS NULL`), or attached through a
 * collection the agent subscribes to. The vector path, the keyword fallback
 * and the Prisma-side queries all need this rule, and a copy that drifts is a
 * silent visibility bug — so there is exactly one definition, in two dialects.
 */

import { Prisma } from '@prisma/client'

/** Raw-SQL form, for the pgvector queries. Emits a bare boolean expression
 *  over the aliased document table `d`. */
export function agentScopeSql(organizationId: string, agentId: string): Prisma.Sql {
  return Prisma.sql`(
    d."agentId" = ${agentId}
    OR d."agentId" IS NULL
    OR d."id" IN (
      SELECT dc."documentId"
        FROM "knowledge_document_collections" dc
        JOIN "agent_knowledge_collections" ac ON ac."collectionId" = dc."collectionId"
       WHERE ac."agentId" = ${agentId}
         AND ac."organizationId" = ${organizationId}::uuid
    )
  )`
}

/** Prisma form, for the keyword fallback and any ORM-side listing. */
export function agentScopeWhere(
  organizationId: string,
  agentId: string,
): Prisma.KnowledgeDocumentWhereInput {
  return {
    OR: [
      { agentId },
      { agentId: null },
      { collections: { some: { collection: { agents: { some: { agentId, organizationId } } } } } },
    ],
  }
}
