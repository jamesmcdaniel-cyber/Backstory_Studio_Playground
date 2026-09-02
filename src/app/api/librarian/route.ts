import Anthropic from '@anthropic-ai/sdk'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { DEFAULT_SUMMARY_MODEL } from '@/lib/llm/model-runner'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
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
//
// The conversation belongs to the server too. A caller names a thread by id and
// the earlier turns are read out of it here — nothing a caller merely CLAIMS
// was said reaches the prompt.

export type { LibrarianResult } from '@/lib/librarian/relevance'

/** External sources shown under an answer, capped so the citation list stays readable. */
const MAX_SOURCES = 4
/** Workspace items shown as cards under an answer. */
const MAX_RESULTS = 4
/**
 * Earlier exchanges replayed into the prompt — the same three the client used
 * to send, now counted off the thread's own rows.
 */
const HISTORY_EXCHANGES = 3

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
 * What a caller may put in front of the model, and — as much to the point —
 * what it may not.
 *
 * This schema used to take a `history` array: eight turns of two thousand
 * characters, ASSISTANT turns included, all of it written by whoever sent the
 * request. Fencing made that text safe to read; it never made it true, and a
 * conversation the caller narrates is one an attacker can put words into the
 * assistant's own mouth in. It is gone, and it is not kept as a fallback — a
 * fallback would be an unverified path that only an attacker has a reason to
 * take. Earlier turns now come off the thread named by `sessionId`.
 *
 * Strict for that reason: a client that starts sending `history` again gets a
 * 400 rather than a silently dropped field, so the channel cannot be
 * reintroduced quietly.
 *
 * `sessionId` and `path` stay optional so a first question and the /dashboard
 * home both work unchanged. `path` is bounded and resolved against the surface
 * registry rather than quoted, and `sessionId` carries no prose at all — it is
 * an id that earlier turns are read AGAINST, never the turns themselves.
 */
const requestSchema = z.object({
  question: z.string().min(1).max(2000),
  sessionId: z.string().min(1).max(64).optional(),
  path: z.string().max(300).optional(),
  // Which surface is asking, and so which scope clause the model is held to.
  // The default is the TIGHTER tier on purpose: a caller that predates this
  // field, or one whose value zod does not recognise, fails toward the narrower
  // boundary rather than being silently promoted to the wider one. Widening is
  // something a caller has to ask for in as many words.
  mode: z.enum(['helper', 'assistant']).default('helper'),
}).strict()

/**
 * A thread's title, taken from the question that started it — the same
 * derivation agent chat uses, so the two history lists read alike. Not imported
 * from there: that `shared.ts` is private to the agent-scoped chat, and
 * everything else it exports threads an agent id through it.
 */
function deriveTitle(question: string): string {
  const text = question.trim().replace(/\s+/g, ' ')
  if (!text) return 'New chat'
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { question, sessionId, path, mode } = requestSchema.parse(await request.json())
  await assertAiCallAllowed({ organizationId: auth.organizationId, rateKey: `librarian:${auth.dbUser.id}`, limit: 30 })

  const words = terms(question)
  const org = auth.organizationId
  const uid = auth.dbUser.id
  // With no usable search terms, surface the most recent library items instead
  // of matching on nothing.
  const hasWords = words.length > 0

  // Which thread this question belongs to, settled before anything is read. An
  // id this caller owns continues that thread; ANY other id — another user's,
  // another workspace's, one cleared from a second tab an hour ago — quietly
  // starts a new one.
  //
  // Deliberately not a 404. Answering "no such thread" for an id the caller
  // does not own would confirm, for any id worth guessing, that it exists and
  // whose it is not; the id would become a probe. It is also the kinder
  // behaviour, since a thread deleted on another device must not turn the next
  // question into an error.
  const existing = sessionId
    ? await prisma.librarianChatSession.findFirst({
        where: { id: sessionId, organizationId: org, userId: uid },
        select: { id: true, title: true },
      })
    : null
  const session =
    existing ??
    (await prisma.librarianChatSession.create({
      data: { organizationId: org, userId: uid, title: deriveTitle(question) },
      select: { id: true, title: true },
    }))

  // The public sources are fetched alongside the workspace queries, not after
  // them, so the docs cost concurrency rather than latency.
  const [docs, agents, flows, templates, runs, turns] = await Promise.all([
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
    // A thread being continued has turns to replay; one created three lines ago
    // provably has none, so the first question of every conversation skips the
    // round trip that could only come back empty.
    existing
      ? prisma.librarianChatMessage.findMany({
          where: { organizationId: org, userId: uid, sessionId: session.id },
          // Newest first under the cap, then reversed below — the ceiling has
          // to be taken from the recent end of a long thread. The id breaks a
          // createdAt tie in creation order (cuids are ordered within a
          // process), so a question never replays after the answer it got.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: HISTORY_EXCHANGES * 2,
          select: { role: true, content: true },
        })
      : Promise.resolve([] as { role: string; content: string }[]),
  ])

  // The earlier turns, oldest first, read from the thread rather than taken
  // from the request. This is what the sessions table is FOR: the caller used
  // to narrate the conversation back to us, assistant turns included, and the
  // prompt had no way to tell an exchange that happened from one that was
  // invented.
  //
  // Storage changes provenance, not trust. These rows are still text a person
  // typed into their own workspace, and the assistant rows are still full of
  // workspace text quoted back — so buildPrompt still redacts them and still
  // fences them, exactly as it did when they arrived over the wire.
  const history = turns.reverse().map((turn) => ({
    // `role` is a free-form column with no CHECK behind it, so this mapping has
    // to be total. Anything that is not an assistant turn reads as a user turn,
    // which is the direction that grants nothing.
    role: turn.role === 'assistant' ? ('assistant' as const) : ('user' as const),
    // The same per-turn ceiling the request schema used to impose. An answer
    // can run to 1,400 tokens, and three of them unclipped would crowd the
    // retrieved sources out of the context the question actually needs.
    content: turn.content.slice(0, 2000),
  }))

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

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new ApiError('No model provider is configured', 503, 'AI_UNAVAILABLE')
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const model = DEFAULT_SUMMARY_MODEL.startsWith('claude') ? DEFAULT_SUMMARY_MODEL : 'claude-haiku-4-5'

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
  // The fallback is stored as well as returned: a thread read back later should
  // be what happened, including the turn where nothing came out of the model.
  const reply = answer || 'I couldn’t generate an answer just now — try rephrasing.'

  // Written only once the model has answered, so a failed call leaves no
  // half-thread behind for the user to find. Both turns in one statement for
  // the same reason: an exchange is the unit a conversation reads back in, and
  // a question stored without its answer is worse than neither.
  // ...and tolerant of the thread having been deleted while the model was
  // thinking. The gap between resolving the session and writing the turns is
  // the whole model call — seconds — and "Delete all conversations" from
  // another tab lands inside it easily. The row is gone, its messages cascaded,
  // and this insert would violate the sessionId foreign key: a 500 and a Sentry
  // report for a question that was answered fine. The user asked for the thread
  // to go, so honouring that and still returning the answer is the correct
  // outcome, and it matches what the DELETE routes already do — they use
  // deleteMany precisely so a vanished thread is a no-op rather than a throw.
  await prisma.librarianChatMessage.createMany({
    data: [
      { sessionId: session.id, organizationId: org, userId: uid, role: 'user', content: question },
      {
        sessionId: session.id,
        organizationId: org,
        userId: uid,
        role: 'assistant',
        content: reply,
        // The cards and citations this answer actually shipped with, so a
        // restored thread renders as it did live instead of as bare text — and
        // so its links stay the ones this route resolved, rather than ones a
        // later reader's model would have to guess at.
        metadata: { results, sources } as unknown as Prisma.InputJsonValue,
      },
    ],
  }).catch((error: unknown) => {
    // P2003 is the foreign key: the session was deleted under us. Anything else
    // is a real write failure and must still surface — swallowing every error
    // here would turn "the database is down" into a silently unsaved thread.
    if ((error as { code?: string })?.code !== 'P2003') throw error
  })
  // The write itself is the point: @updatedAt moves, and the thread sorts to
  // the top of the history list. The title is RESTATED rather than recomputed,
  // so a thread keeps the question that opened it instead of drifting to
  // whatever was asked last — the fallback is only for a row that reached here
  // without one.
  //
  // Best-effort: the turns above are already durable, and a cosmetic bump must
  // not cost the user the answer they just waited for. Scoped by
  // organizationId and userId all the same — the tenant guard rejects an
  // unscoped write, and a swallowed throw is exactly how an unscoped one would
  // go unnoticed forever.
  await prisma.librarianChatSession
    .update({
      where: { id: session.id, organizationId: org, userId: uid },
      data: { title: session.title ?? deriveTitle(question) },
    })
    .catch(() => undefined)

  return { success: true, sessionId: session.id, answer: reply, results, sources }
}, { permission: 'agent.run' })
