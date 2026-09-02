/**
 * The repository as agent-callable tools.
 *
 * Before these existed, an agent received five passages chosen before the run
 * started, from a query built out of its objective — it could not look
 * anything up, ask a better question, or read a document it knew it needed.
 * These three tools are that missing half; `repository_read` in particular is
 * what makes a long document usable, because `nextOffset` lets an agent walk
 * it instead of sampling it.
 *
 * Defined once and registered twice: as the `backstory://repository` native
 * plane for agents (src/features/agents/tool-planes.ts) and as MCP tools for
 * external callers (src/app/api/mcp/route.ts). Every tool is read-only.
 */

import { prisma } from '@/lib/prisma'
import { retrieveKnowledge } from './retrieve'
import { agentScopeWhere } from './scope'
import { listCollections } from './collections'

export const REPOSITORY_SEARCH_DEFAULT_K = 8
export const REPOSITORY_READ_DEFAULT_LIMIT = 8_000
export const REPOSITORY_READ_MAX_LIMIT = 20_000
export const REPOSITORY_LIST_MAX = 100

export const REPOSITORY_TOOLS = [
  {
    name: 'repository_search',
    description:
      'Search the workspace repository of reference material — enablement docs, customer journey maps, playbooks, synced project files — and get back the most relevant passages with the document they came from. Use this whenever the answer depends on how this company does things rather than on general knowledge. Prefer a specific question over a keyword.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to know, in a sentence.' },
        collection: { type: 'string', description: 'Optional collection name to search within, e.g. Customer Journey.' },
        documentId: { type: 'string', description: 'Optional: restrict the search to one document.' },
        topK: { type: 'number', description: 'How many passages to return, 1-20. Defaults to 8.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'repository_read',
    description:
      'Read a repository document straight through, a window at a time. Use this after repository_search when passages are not enough and you need the document in order — a stage-by-stage journey map, a full playbook. Pass the returned nextOffset back to continue; a null nextOffset means you have reached the end.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string', description: 'The document id, from repository_search or repository_list.' },
        offset: { type: 'number', description: 'Character offset to start at. Defaults to 0.' },
        limit: { type: 'number', description: `Characters to return, up to ${REPOSITORY_READ_MAX_LIMIT}. Defaults to ${REPOSITORY_READ_DEFAULT_LIMIT}.` },
      },
      required: ['documentId'],
    },
  },
  {
    name: 'repository_list',
    description:
      'List the reference documents and collections available to you, with their descriptions. Use this to find out what exists before searching, or when a search comes back empty and you want to know whether the material is there at all.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Optional collection name to list within.' },
        search: { type: 'string', description: 'Optional filter on file name or description.' },
      },
    },
  },
] satisfies ReadonlyArray<{
  name: string
  description: string
  isWrite: false
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
}>
// NOTE: plain `satisfies`, deliberately not `as const satisfies` — `as const`
// would make `required` a readonly tuple, which does not satisfy `string[]`.

/** Unknown names default to write — an unrecognized tool never bypasses the approval gate. */
export function repositoryToolIsWrite(name: string): boolean {
  return REPOSITORY_TOOLS.find((tool) => tool.name === name)?.isWrite ?? true
}

const clamp = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.max(min, Math.min(max, n))
}

export class RepositoryToolClient {
  /**
   * `agentId` is the agent's own id when an agent is calling. MCP callers pass
   * null: they have no agent identity, so they see org-wide documents plus
   * their own, bounded by the same user-visibility rule the repository UI uses.
   */
  constructor(
    private readonly organizationId: string,
    private readonly userId: string,
    private readonly agentId: string | null = null,
  ) {}

  private scopeWhere() {
    return this.agentId
      ? agentScopeWhere(this.organizationId, this.agentId)
      : { OR: [{ agentId: null }, { userId: this.userId }] }
  }

  private async collectionIdByName(name: string): Promise<string | null> {
    const row = await prisma.knowledgeCollection.findFirst({
      where: { organizationId: this.organizationId, name: { equals: name.trim(), mode: 'insensitive' } },
      select: { id: true },
    })
    return row?.id ?? null
  }

  async executeTool(_serverUrl: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'repository_search': {
        const query = String(args.query ?? '').trim()
        if (!query) return { passages: [], note: 'Pass a question to search for.' }
        const wantsCollection = typeof args.collection === 'string' && args.collection.trim()
        const collectionId = wantsCollection ? await this.collectionIdByName(String(args.collection)) : null
        if (wantsCollection && !collectionId) {
          return { passages: [], note: `There is no collection named "${String(args.collection)}". Call repository_list to see what exists.` }
        }
        const hits = await retrieveKnowledge({
          organizationId: this.organizationId,
          // '' matches no agent row, so an MCP caller gets the org-wide branch.
          agentId: this.agentId ?? '',
          query,
          k: clamp(args.topK, REPOSITORY_SEARCH_DEFAULT_K, 1, 20),
          ...(collectionId ? { collectionId } : {}),
        })
        const filtered = typeof args.documentId === 'string' && args.documentId
          ? hits.filter((hit) => hit.documentId === args.documentId)
          : hits
        return {
          passages: filtered.map((hit) => ({
            documentId: hit.documentId,
            filename: hit.filename,
            text: hit.content,
            score: Number(hit.score.toFixed(3)),
            matchedBy: hit.matchedBy ?? 'vector',
            citation: `[doc:${hit.documentId} "${hit.filename}"]`,
          })),
        }
      }

      case 'repository_read': {
        const documentId = String(args.documentId ?? '')
        const document = await prisma.knowledgeDocument.findFirst({
          where: {
            id: documentId,
            organizationId: this.organizationId,
            isEnabled: true,
            status: 'ready',
            ...this.scopeWhere(),
          },
          select: { id: true, filename: true, description: true, content: true, truncated: true },
        })
        if (!document) return { error: 'No readable document with that id is available to you.' }
        const text = document.content ?? ''
        const offset = clamp(args.offset, 0, 0, Math.max(0, text.length))
        const limit = clamp(args.limit, REPOSITORY_READ_DEFAULT_LIMIT, 1, REPOSITORY_READ_MAX_LIMIT)
        const slice = text.slice(offset, offset + limit)
        const nextOffset = offset + slice.length < text.length ? offset + slice.length : null
        return {
          documentId: document.id,
          filename: document.filename,
          description: document.description,
          totalChars: text.length,
          offset,
          nextOffset,
          truncatedAtIngest: document.truncated,
          citation: `[doc:${document.id} "${document.filename}"]`,
          text: slice,
        }
      }

      case 'repository_list': {
        const search = typeof args.search === 'string' ? args.search.trim().slice(0, 200) : ''
        const wantsCollection = typeof args.collection === 'string' && args.collection.trim()
        const collectionId = wantsCollection ? await this.collectionIdByName(String(args.collection)) : null
        if (wantsCollection && !collectionId) {
          return { documents: [], collections: [], note: `There is no collection named "${String(args.collection)}".` }
        }
        const documents = await prisma.knowledgeDocument.findMany({
          where: {
            organizationId: this.organizationId,
            isEnabled: true,
            status: 'ready',
            ...this.scopeWhere(),
            ...(collectionId ? { collections: { some: { collectionId } } } : {}),
            ...(search
              ? {
                  AND: [{
                    OR: [
                      { filename: { contains: search, mode: 'insensitive' } },
                      { description: { contains: search, mode: 'insensitive' } },
                    ],
                  }],
                }
              : {}),
          },
          orderBy: { updatedAt: 'desc' },
          take: REPOSITORY_LIST_MAX,
          select: {
            id: true, filename: true, description: true, charCount: true, indexState: true,
            collections: { select: { collection: { select: { name: true } } } },
          },
        })
        return {
          documents: documents.map((document) => ({
            documentId: document.id,
            filename: document.filename,
            description: document.description,
            chars: document.charCount,
            collections: document.collections.map((join) => join.collection.name),
            searchable: document.indexState === 'indexed' ? 'full' : 'keyword only',
          })),
          collections: (await listCollections({ organizationId: this.organizationId }))
            .map((collection) => ({ name: collection.name, documents: collection.documentCount })),
        }
      }

      default:
        throw new Error(`Unknown repository tool "${name}".`)
    }
  }
}
