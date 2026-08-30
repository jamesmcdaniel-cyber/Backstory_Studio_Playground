import { UNTRUSTED_DATA_RULE } from '@/lib/security/prompt'
import { GUARDRAIL_RULE } from '@/lib/security/guardrails'
import { z } from 'zod'
import { generateStructured } from '@/lib/llm/model-runner'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { parseMatches } from '@/lib/templates/ai-search'
import { assertAiCallAllowed, recordEstimatedUsage } from '@/lib/usage/ai-guard'

const ItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
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

/** `id | name | provider` per line, one-indexed. */
function formatCatalog(items: z.infer<typeof ItemSchema>[]): string {
  return items.map((item, i) => `${i + 1}. ${item.id} | ${item.name} | ${item.provider}`).join('\n')
}

const MAX_MATCHES = 6

// AI integration finder — mirrors /api/templates/ai-search: the client sends
// its already-loaded integration catalog, so no extra DB access is needed. The
// model only ranks/reasons; the id filter below is the source of truth, so a
// hallucinated id can never reach the UI.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const { query, items } = BodySchema.parse(await request.json())
  // Gate before model spend: provider, per-user rate limit, monthly ceiling.
  await assertAiCallAllowed({ organizationId: auth.organizationId, rateKey: `ai-search:${auth.dbUser.id}`, limit: 20 })

  let raw: string
  try {
    raw = await generateStructured({
      schemaName: 'integration_matches',
      schema: MATCHES_SCHEMA as unknown as Record<string, unknown>,
      // The id half of each match is closed — the loop below drops anything the
      // caller did not send — but `reason` is a sentence the model writes and
      // this route hands back verbatim. That prose is the channel the
      // boundaries are for: it is rendered as the product's own explanation of
      // a match, so an integration name or provider string carrying an
      // injection has somewhere to put a forged notice.
      system: [
        "You match a user's goal to the integrations that would help accomplish it. Return ONLY integrations from the catalog that genuinely help — an empty list is the correct answer when nothing fits. Rank best-first, at most 6, each with a one-sentence reason tied to the goal.",
        UNTRUSTED_DATA_RULE,
        GUARDRAIL_RULE,
      ].join('\n\n'),
      user: `Goal: ${query}\n\nIntegrations (id | name | provider):\n${formatCatalog(items)}`,
      maxTokens: 1024,
    })
  } catch (error) {
    throw new ApiError('AI search is not configured for this workspace.', 503, 'AI_SEARCH_UNAVAILABLE', error)
  }
  recordEstimatedUsage(auth.organizationId, query, formatCatalog(items), raw)

  // Keep only ids the client actually sent; dedupe; cap. (parseMatches tolerates
  // whatever shape the model returns.)
  const known = new Set(items.map((i) => i.id))
  const seen = new Set<string>()
  const matches: { id: string; reason: string }[] = []
  for (const m of parseMatches(raw)) {
    if (seen.has(m.id) || !known.has(m.id)) continue
    seen.add(m.id)
    matches.push({ id: m.id, reason: m.reason })
    if (matches.length >= MAX_MATCHES) break
  }
  return { success: true, matches }
}, { permission: 'flow.read' })
