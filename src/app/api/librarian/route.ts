import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { DEFAULT_SUMMARY_MODEL } from '@/lib/llm/model-runner'
import { qwenClient, qwenModel } from '@/lib/llm/qwen'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope, executionVisibilityScope } from '@/lib/server/visibility'
import { GUARDRAIL_RULE } from '@/lib/security/guardrails'
import { scopeRule } from '@/lib/security/scope'
import { assertAiCallAllowed, recordPiiEgress } from '@/lib/usage/ai-guard'
import { recordTokenUsage } from '@/lib/usage/budget'
import { citedItems, citedSources, dedupeResults, parseRelevance, type LibrarianResult } from '@/lib/librarian/relevance'
import { searchBuiltinCatalogue } from '@/lib/librarian/catalogue'
import { appSurfaces, surfaceForPath } from '@/lib/librarian/surfaces'
import { retrieveKnowledge, SOURCE_LABEL, type KnowledgeDoc } from '@/lib/help-center/retrieve'
import { buildPrompt, SYSTEM_PROMPT } from '@/lib/librarian/prompt'

// The Assistant: a holistic workspace assistant (the /dashboard home). It
// answers general questions about Backstory from the three public sites that
// document it (help centre, developer docs, automation library) and, WHEN THEY
// ARE ACTUALLY RELEVANT, links the user's own library — templates, flows,
// agents, recent runs. The keyword search below only assembles candidates; the
// model marks which ones it stood behind and the rest never reach the UI.
//
// Every URL the user sees is one this route retrieved, never one the model
// wrote: the model cites by number and the numbers are resolved back to the
// fetched sources here, so a citation cannot point at a page that does not
// exist.

export type { LibrarianResult } from '@/lib/librarian/relevance'

/** External sources shown under an answer, capped so the citation list stays readable. */
const MAX_SOURCES = 4
/** Workspace items shown as cards under an answer. */
const MAX_RESULTS = 4

export type LibrarianSource = {
  title: string
  url: string
  /** Which site it came from, in the words the UI shows. */
  label: string
}

/** Meaningful search terms from the question (drop short/stop words). */
function terms(question: string): string[] {
  const stop = new Set(['the', 'and', 'for', 'with', 'how', 'can', 'what', 'you', 'are', 'this', 'that', 'from', 'about', 'into', 'does', 'should', 'could', 'would', 'when', 'where', 'which', 'your', 'our', 'get'])
  return Array.from(new Set(
    question.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !stop.has(w)),
  )).slice(0, 6)
}

function orContains(words: string[], fields: string[]) {
  const clauses: Record<string, unknown>[] = []
  for (const w of words) for (const f of fields) clauses.push({ [f]: { contains: w, mode: 'insensitive' } })
  return clauses
}

/**
 * `history` and `path` are optional so the /dashboard home keeps working
 * unchanged: they are what the Ask Backstory widget adds — a follow-up needs the
 * turns before it, and "how do I fix this?" needs to know which page "this" is.
 * Both are bounded here, and `path` is resolved against the surface registry
 * rather than quoted, so neither becomes a channel for arbitrary prompt text.
 */
const requestSchema = z.object({
  question: z.string().min(1).max(2000),
  history: z
    .array(z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().transform((content) => content.slice(0, 2000)),
    }))
    .max(8)
    .optional(),
  path: z.string().max(300).optional(),
  // Which surface is asking, and so which scope clause the model is held to.
  // The default is the TIGHTER tier on purpose: a caller that predates this
  // field, or one whose value zod does not recognise, fails toward the narrower
  // boundary rather than being silently promoted to the wider one. Widening is
  // something a caller has to ask for in as many words.
  mode: z.enum(['helper', 'assistant']).default('helper'),
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { question, history, path, mode } = requestSchema.parse(await request.json())
  await assertAiCallAllowed({ organizationId: auth.organizationId, rateKey: `librarian:${auth.dbUser.id}`, limit: 30 })

  const words = terms(question)
  const org = auth.organizationId
  const uid = auth.dbUser.id
  // With no usable search terms, surface the most recent library items instead
  // of matching on nothing.
  const hasWords = words.length > 0

  // The public sources are fetched alongside the workspace queries, not after
  // them, so the docs cost concurrency rather than latency.
  const [docs, agents, flows, templates, runs] = await Promise.all([
    retrieveKnowledge(question),
    // AND, never two spread `OR` keys: the second would overwrite the first in
    // the same object literal, silently dropping the visibility scope for any
    // search that carries words — which is every real search.
    prisma.agentTask.findMany({
      where: {
        organizationId: org,
        AND: [agentVisibilityScope(uid), ...(hasWords ? [{ OR: orContains(words, ['description', 'objective']) }] : [])],
      },
      orderBy: { updatedAt: 'desc' },
      take: 4,
      select: { id: true, description: true, folder: true, metadata: true },
    }),
    prisma.flow.findMany({
      where: {
        organizationId: org,
        AND: [agentVisibilityScope(uid), ...(hasWords ? [{ OR: orContains(words, ['name', 'description']) }] : [])],
      },
      orderBy: { updatedAt: 'desc' },
      take: 4,
      select: { id: true, name: true, description: true, status: true },
    }),
    prisma.agentTemplate.findMany({
      where: { organizationId: org, isActive: true, ...(hasWords ? { OR: orContains(words, ['name', 'description']) } : {}) },
      orderBy: { updatedAt: 'desc' },
      take: 4,
      select: { id: true, name: true, description: true },
    }),
    prisma.agentExecution.findMany({
      where: {
        organizationId: org,
        AND: [
          executionVisibilityScope(uid),
          ...(hasWords
            ? [{ OR: [...orContains(words, ['agentType']), { agentTask: { is: { OR: orContains(words, ['description', 'objective']) } } }] }]
            : []),
        ],
      },
      orderBy: { startedAt: 'desc' },
      take: 4,
      select: { id: true, agentType: true, status: true, startedAt: true, metadata: true },
    }),
  ])

  const titleOf = (metadata: unknown, fallback: string) => {
    const m = (metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}) as Record<string, unknown>
    return (typeof m.title === 'string' && m.title.trim()) || fallback
  }

  const workspaceItems = dedupeResults([
    // The product's own pages, so "where do I connect Slack?" is answered with
    // a link rather than a description of a link. Permission-filtered, and
    // unconditional (not keyword-matched): they are also the map the model
    // reads to describe the app, and a map with pages missing is how an
    // assistant starts inventing a screen that does not exist.
    ...appSurfaces(auth.can),
    // The catalogue the platform ships (code, not rows) — without this the
    // Assistant cannot see its own gallery and denies that a template exists.
    ...searchBuiltinCatalogue(words),
    ...flows.map((f): LibrarianResult => ({ type: 'flow', id: f.id, title: f.name || 'Untitled flow', subtitle: `Flow · ${f.status.toLowerCase()}`, href: `/flows/${f.id}` })),
    ...agents.map((a): LibrarianResult => ({ type: 'agent', id: a.id, title: titleOf(a.metadata, a.description.split('\n')[0] || 'Untitled agent'), subtitle: a.folder ? `Agent · ${a.folder}` : 'Agent', href: `/agents?agent=${a.id}` })),
    ...templates.map((t): LibrarianResult => ({ type: 'template', id: t.id, title: t.name, subtitle: 'Template', href: `/templates/${t.id}` })),
    ...runs.map((r): LibrarianResult => ({ type: 'run', id: r.id, title: titleOf(r.metadata, r.agentType), subtitle: `Run · ${r.status.toLowerCase()}`, href: `/agents?run=${r.id}` })),
  ])

  // Retrieved passages are numbered straight on from the workspace items, so
  // the model cites a source the way it cites an item and one RELEVANT line
  // covers both. `citedItems`/`citedSources` split that numbering back apart.
  const candidateCount = workspaceItems.length + docs.length
  const prompt = buildPrompt(question, workspaceItems, docs, { history, surface: surfaceForPath(path) })

  // Recorded here rather than at the shared structured-call seam in
  // lib/llm/model-runner.ts, which records for every other interactive endpoint:
  // this one calls the Messages API directly and so never passes through it.
  void recordPiiEgress({ organizationId: org, userId: uid, surface: 'librarian', text: prompt })

  const useClaude = Boolean(process.env.ANTHROPIC_API_KEY)
  const client = useClaude ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : qwenClient()
  const model = useClaude
    ? (DEFAULT_SUMMARY_MODEL.startsWith('claude') ? DEFAULT_SUMMARY_MODEL : 'claude-haiku-4-5')
    : qwenModel(DEFAULT_SUMMARY_MODEL.startsWith('claude') ? 'qwen-3.7' : DEFAULT_SUMMARY_MODEL)

  const response = await client.messages.create({
    model,
    // Headroom for a fully-worked capability answer plus the RELEVANT line; a
    // 700-token ceiling truncated them mid-list.
    max_tokens: 1_400,
    // Composed here rather than baked into SYSTEM_PROMPT, matching the other
    // three model surfaces: `mode` is a per-request value, and the guardrails
    // are a platform-wide clause that must read identically wherever it appears.
    // `mode` reaches ONLY this string — retrieval, candidate assembly, the
    // shared numbering and citation resolution above are byte-identical across
    // tiers, which is what makes "one brain, two scopes" a claim you can test
    // rather than a claim you have to trust.
    system: `${SYSTEM_PROMPT}\n\n${scopeRule(mode)}\n\n${GUARDRAIL_RULE}`,
    messages: [{ role: 'user', content: prompt }],
  })
  void recordTokenUsage(org, (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0)).catch(() => undefined)

  const raw = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()

  // Only the items the model actually stood behind are returned — the rest of
  // the keyword match stays out of the UI.
  const { answer, picked } = parseRelevance(raw, candidateCount)
  const results = citedItems(picked, workspaceItems).slice(0, MAX_RESULTS)

  // Every URL shown is one this route fetched, resolved back from the number
  // the model gave — so a citation cannot point at a page that does not exist.
  const sources: LibrarianSource[] = citedSources<KnowledgeDoc>(picked, workspaceItems.length, docs)
    .slice(0, MAX_SOURCES)
    .map((d) => ({ title: d.title, url: d.url, label: SOURCE_LABEL[d.source] }))

  return { success: true, answer: answer || 'I couldn’t generate an answer just now — try rephrasing.', results, sources }
}, { permission: 'agent.run' })
