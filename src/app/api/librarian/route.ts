import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { DEFAULT_SUMMARY_MODEL } from '@/lib/llm/model-runner'
import { qwenClient, qwenModel } from '@/lib/llm/qwen'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope, executionVisibilityScope } from '@/lib/server/visibility'
import { assertAiCallAllowed } from '@/lib/usage/ai-guard'
import { recordTokenUsage } from '@/lib/usage/budget'
import { dedupeResults, parseRelevance, type LibrarianResult } from '@/lib/librarian/relevance'
import { searchBuiltinCatalogue } from '@/lib/librarian/catalogue'
import { retrieveHelpDocs } from '@/lib/help-center/docs'

// The Assistant: a holistic workspace assistant (the /dashboard home). It
// answers general questions about Backstory and, WHEN THEY ARE ACTUALLY
// RELEVANT, links the user's own library — templates, flows, agents, recent
// runs. The keyword search below only assembles candidates; the model marks
// which ones it stood behind and the rest never reach the UI.

export type { LibrarianResult } from '@/lib/librarian/relevance'

// Named "the Assistant" to match what the UI calls it (src/app/dashboard/page.tsx).
const SYSTEM_PROMPT = `You are the Assistant, a concise workspace assistant inside Backstory Studio — a platform where sales teams build AI agents and automated flows over their connected tools (Slack, Gmail, Salesforce, Jira, Granola, and a Backstory MCP for account/deal data).

Answer the question directly, in 2–5 sentences of plain English. No preamble, no restating the question. Markdown is fine for emphasis and short lists.

Different questions want different answers, so pick the one that fits:
- A plain factual or conceptual question ("what is X", "can Backstory do Y") wants a plain answer and nothing else.
- A "how do I" question wants concrete guidance — the steps, or where in the product to go.
- A question about the user's own workspace wants their actual items named.

You may be given HELP CENTRE excerpts: official Backstory product documentation. It is the authoritative source on how Backstory itself works — features, setup, integrations, MCP, permissions. When an excerpt covers the question, answer from it and say what it says, rather than from your own general knowledge; when the excerpts contradict what you assumed, the excerpts win. If they only partly cover it, use what they do cover and be plain about the rest.

You may also be given CANDIDATE items. These are two different things: entries labelled "agent template" or "flow template" are the READY-MADE library Backstory Studio ships — anyone can open one and deploy it — while the rest are the user's own agents, flows, and past runs. That list is a keyword match, NOT a recommendation: it is often irrelevant, and most answers should cite nothing from it. Refer to an item only when it genuinely answers the question or is the obvious next step, and never pad an answer with a generic "explore the Agents section" or "check your existing agents". Never invent items that are not listed.

When someone asks whether something exists or which template does a job, a matching template in that list IS the answer — name it and say it is ready to deploy. Only say the library has nothing for it when no candidate fits; never tell the user to go and look for themselves through a list you were given.

End your reply with one final line, exactly this shape and nothing after it:
RELEVANT: 1, 3
listing the numbers of the candidates you actually referred to or are recommending — or "RELEVANT: none" when the answer stands on its own. This line is stripped before the user sees it; only the items you list are shown to them.`


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

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { question } = z.object({ question: z.string().min(1).max(2000) }).parse(await request.json())
  await assertAiCallAllowed({ organizationId: auth.organizationId, rateKey: `librarian:${auth.dbUser.id}`, limit: 30 })

  const words = terms(question)
  const org = auth.organizationId
  const uid = auth.dbUser.id
  // With no usable search terms, surface the most recent library items instead
  // of matching on nothing.
  const hasWords = words.length > 0

  // The help centre is fetched alongside the workspace queries, not after them,
  // so the docs cost concurrency rather than latency.
  const [docs, agents, flows, templates, runs] = await Promise.all([
    retrieveHelpDocs(question),
    prisma.agentTask.findMany({
      where: { organizationId: org, ...agentVisibilityScope(uid), ...(hasWords ? { OR: orContains(words, ['description', 'objective']) } : {}) },
      orderBy: { updatedAt: 'desc' },
      take: 4,
      select: { id: true, description: true, folder: true, metadata: true },
    }),
    prisma.flow.findMany({
      where: { organizationId: org, ...(hasWords ? { OR: orContains(words, ['name', 'description']) } : {}) },
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
      where: { organizationId: org, ...executionVisibilityScope(uid), ...(hasWords ? { OR: [...orContains(words, ['agentType']), { agentTask: { is: { OR: orContains(words, ['description', 'objective']) } } }] } : {}) },
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
    // The catalogue the platform ships (code, not rows) — without this the
    // Assistant cannot see its own gallery and denies that a template exists.
    ...searchBuiltinCatalogue(words),
    ...flows.map((f): LibrarianResult => ({ type: 'flow', id: f.id, title: f.name || 'Untitled flow', subtitle: `Flow · ${f.status.toLowerCase()}`, href: `/flows/${f.id}` })),
    ...agents.map((a): LibrarianResult => ({ type: 'agent', id: a.id, title: titleOf(a.metadata, a.description.split('\n')[0] || 'Untitled agent'), subtitle: a.folder ? `Agent · ${a.folder}` : 'Agent', href: `/agents?agent=${a.id}` })),
    ...templates.map((t): LibrarianResult => ({ type: 'template', id: t.id, title: t.name, subtitle: 'Template', href: `/templates/${t.id}` })),
    ...runs.map((r): LibrarianResult => ({ type: 'run', id: r.id, title: titleOf(r.metadata, r.agentType), subtitle: `Run · ${r.status.toLowerCase()}`, href: `/agents?run=${r.id}` })),
  ])

  // Help-centre articles join the same numbered list, so the model can cite a
  // doc the way it cites a workspace item and the UI links it identically.
  const candidates = [
    ...workspaceItems,
    ...docs.map((d): LibrarianResult => ({ type: 'doc', id: d.url, title: d.title, subtitle: 'Help centre', href: d.url })),
  ]
  // One numbering space across both blocks — the RELEVANT line the model
  // returns indexes into `candidates`, so items and docs must share it.
  const itemBlock = workspaceItems.length
    ? `CANDIDATE items from this workspace (keyword match — judge relevance yourself):\n${workspaceItems
        .map((r, i) => `${i + 1}. [${r.type}] ${r.title} — ${r.subtitle}`)
        .join('\n')}`
    : 'This workspace has no items matching the question.'
  const docBlock = docs.length
    ? `\n\nHELP CENTRE excerpts (official Backstory documentation — authoritative), numbered in the same list:\n\n${docs
        .map((d, i) => `${workspaceItems.length + i + 1}. [doc] ${d.title} — ${d.url}\n${d.text}`)
        .join('\n\n')}`
    : ''
  const prompt = `${itemBlock}${docBlock}\n\nUser question: ${question}`

  const useClaude = Boolean(process.env.ANTHROPIC_API_KEY)
  const client = useClaude ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : qwenClient()
  const model = useClaude
    ? (DEFAULT_SUMMARY_MODEL.startsWith('claude') ? DEFAULT_SUMMARY_MODEL : 'claude-haiku-4-5')
    : qwenModel(DEFAULT_SUMMARY_MODEL.startsWith('claude') ? 'qwen-3.7' : DEFAULT_SUMMARY_MODEL)

  const response = await client.messages.create({
    model,
    max_tokens: 700,
    system: SYSTEM_PROMPT,
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
  const { answer, picked } = parseRelevance(raw, candidates.length)
  const results = picked.slice(0, 4).map((n) => candidates[n - 1])

  return { success: true, answer: answer || 'I couldn’t generate an answer just now — try rephrasing.', results }
})
