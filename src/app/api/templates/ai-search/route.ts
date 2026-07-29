import { z } from 'zod'
import { generateStructured } from '@/lib/llm/model-runner'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { parseMatches, sanitizeMatches, type CatalogItem } from '@/lib/templates/ai-search'
import { assertAiCallAllowed, recordEstimatedUsage } from '@/lib/usage/ai-guard'

const ItemSchema = z.object({
  id: z.string(),
  kind: z.enum(['template', 'skill']),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  tags: z.array(z.string()).optional(),
})

const BodySchema = z.object({
  query: z.string().min(3).max(500),
  items: z.array(ItemSchema).min(1).max(200),
})

const MATCHES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['id', 'reason'],
      },
    },
  },
  required: ['matches'],
} as const

const DESCRIPTION_CLIP = 200

/** `id | kind | name | category | description | tags` per line, one-indexed. */
function formatCatalog(items: z.infer<typeof ItemSchema>[]): string {
  return items
    .map((item, index) => {
      const description =
        item.description.length > DESCRIPTION_CLIP
          ? `${item.description.slice(0, DESCRIPTION_CLIP)}…`
          : item.description
      const tags = (item.tags ?? []).join(', ')
      return `${index + 1}. ${item.id} | ${item.kind} | ${item.name} | ${item.category} | ${description} | ${tags}`
    })
    .join('\n')
}

// AI template finder: the client sends its already-loaded catalog (templates +
// skills), so this route needs no extra DB access and works for either tab.
// The model only ranks/reasons — sanitizeMatches is the source of truth for
// which ids are real, so a hallucinated id can never reach the UI.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const { query, items } = BodySchema.parse(await request.json())
  // Gate before model spend: provider, per-user rate limit, monthly ceiling.
  await assertAiCallAllowed({ organizationId: auth.organizationId, rateKey: `ai-search:${auth.dbUser.id}`, limit: 20 })

  let raw: string
  try {
    raw = await generateStructured({
      schemaName: 'template_matches',
      schema: MATCHES_SCHEMA as unknown as Record<string, unknown>,
      system:
        "You match a user's goal to the best library templates/skills. Return ONLY items that genuinely help accomplish the stated goal — an empty list is the correct answer when nothing fits. Rank best-first, at most 5, each with a one-sentence reason tied to the goal.",
      user: `Goal: ${query}\n\nCatalog (id | kind | name | category | description | tags):\n${formatCatalog(items)}`,
      maxTokens: 1024,
    })
  } catch (error) {
    throw new ApiError('AI search is not configured for this workspace.', 503, 'AI_SEARCH_UNAVAILABLE', error)
  }
  recordEstimatedUsage(auth.organizationId, query, formatCatalog(items), raw)

  const matches = sanitizeMatches(parseMatches(raw), items as CatalogItem[])
  return { success: true, matches }
}, { permission: 'agent.read' })
