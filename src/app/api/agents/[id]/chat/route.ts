import { GUARDRAIL_RULE } from '@/lib/security/guardrails'
import { UNTRUSTED_DATA_RULE } from '@/lib/security/prompt'
import type { AgentChatMessage, Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { generateStructured } from '@/lib/llm/model-runner'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { buildAssistantContext } from '@/features/agents/assistant-context'
import { runAgentExecution } from '@/features/agents/execute-agent'
import { inlineExecution } from '@/lib/queue/execution-mode'
import { createQueue, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { rateLimit } from '@/lib/ratelimit'
import { assertAiCallAllowed } from '@/lib/usage/ai-guard'
import { recordTokenUsage } from '@/lib/usage/budget'
import { buildChatLedgerContext } from '@/lib/usage/chat-ledger'
import { injectTraceContext } from '@/lib/observability/otel'
import {
  agentIdFromRequest,
  requireAgent,
  deriveTitle,
  normalizeProposal,
  normalizeRunIntent,
  proposalSchema,
  runIntentSchema,
  LEGACY_SESSION_ID,
  type NormalizedProposal,
  type NormalizedRunIntent,
} from './shared'

export const runtime = 'nodejs'
// Matches the execute route: a chat-triggered run executes inline here, so the
// request needs the same headroom as a manual run, not just a model call.
export const maxDuration = 1800

/**
 * Agent-scoped assistant chat. Extends the per-execution follow-up chat
 * (/api/chat) to a persistent per-agent thread: GET returns the thread,
 * POST answers with server-assembled run context and may return a config
 * proposal — or, when the user asks the agent to do something, executes the
 * agent with its own tools and returns the run's output as the reply. PATCH
 * marks a proposal as applied (the client applies it via the existing
 * PUT /api/agents after an explicit confirm).
 */

const SYSTEM_PROMPT = [
  "You are the Backstory assistant for a single agent. You answer questions about the agent's recent runs, help debug failures, turn natural-language requests into configuration changes, and run the agent on the user's behalf.",
  "When the user asks the agent to actually DO something now — run its job, execute a command, look something up, or draft/send/post something using its connected tools — set run.task to one complete, self-contained instruction for that run, folding in every specific from the conversation. Set proposal to null when run is set. Write reply as one short sentence saying what the run will do; the run's output is delivered with it. Use run only for action requests: questions about past runs, capabilities, or configuration are answered directly, and requests to permanently change how the agent works are proposals, not runs.",
  'Ground every statement in the provided context (agent config, recent runs, tool calls, errors). If the context does not contain the answer, say so plainly.',
  'When the user asks to change the agent — its instructions/objective, schedule, skills, connected tools/integrations, model, name, or description — fill in the proposal object with only the fields that should change and set every other proposal field to null. The instructions field must contain the complete updated instructions text, not a diff. Never claim a change was applied; the user reviews and confirms it in the interface.',
  'Set proposal.target to "update" when the request changes how THIS agent does the job it already has. Set it to "new" when the request describes a DIFFERENT job — a task, lookup, or report this agent was not built for, or when the user asks for instructions for an agent to run. A "new" proposal must include title, description, and complete instructions, and must leave model, integrations and skills null: the new agent inherits this agent\'s tools, skills and model automatically.',
  'When the message is not a change request, set proposal to null.',
  'When debugging, use the latest failed run: quote the relevant error and the tool calls around it.',
  'When asked what Backstory MCP does or what can be done with it, enumerate every tool in context.backstoryTools by exact name and explain what each one does. Do not group tools in a way that omits individual names. If the catalog is empty, say it could not be loaded rather than inventing a list.',
  'Write concise markdown in sentence case. No emoji.',
].join('\n')

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reply: {
      type: 'string',
      description: 'The answer shown to the user, in concise markdown. Sentence case, no emoji.',
    },
    proposal: {
      type: ['object', 'null'],
      additionalProperties: false,
      description: 'A concrete configuration change for the user to confirm, or null when the message is not a change request.',
      properties: {
        summary: { type: 'string', description: 'One sentence describing the change.' },
        target: {
          type: 'string',
          enum: ['update', 'new'],
          description: '"update" changes this agent. "new" creates a separate agent from these instructions, inheriting this agent\'s tools, skills and model.',
        },
        title: { type: ['string', 'null'] },
        description: { type: ['string', 'null'] },
        instructions: { type: ['string', 'null'], description: 'Complete replacement instructions, not a diff.' },
        model: { type: ['string', 'null'] },
        integrations: { type: ['array', 'null'], items: { type: 'string' } },
        skills: { type: ['array', 'null'], items: { type: 'string' } },
        schedule: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: {
            type: { type: 'string', enum: ['manual', 'hourly', 'daily', 'weekly', 'cron'] },
            time: { type: 'string', description: '24h HH:MM start time; empty string when not applicable.' },
            cron: { type: 'string', description: 'Cron expression; empty string unless type is "cron".' },
            timezone: { type: 'string', description: 'IANA timezone, e.g. UTC.' },
            isActive: { type: 'boolean' },
          },
          required: ['type', 'time', 'cron', 'timezone', 'isActive'],
        },
      },
      required: ['summary', 'target', 'title', 'description', 'instructions', 'model', 'integrations', 'skills', 'schedule'],
    },
    run: {
      type: ['object', 'null'],
      additionalProperties: false,
      description:
        'Set when the user asks the agent to perform work now using its connected tools; the run starts immediately after this reply. Null otherwise, and always null when proposal is set.',
      properties: {
        task: {
          type: 'string',
          description: 'One complete, self-contained instruction for this run, folding in the specifics from the conversation.',
        },
      },
      required: ['task'],
    },
  },
  required: ['reply', 'proposal', 'run'],
} as const

function serializeMessage(message: AgentChatMessage) {
  const metadata =
    message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
      ? (message.metadata as Record<string, unknown>)
      : {}
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    proposal: metadata.proposal ?? null,
    appliedAt: metadata.appliedAt ?? null,
    // Set when this reply came from (or started) an agent run: the task that
    // ran, the execution id, and how it ended.
    run: metadata.run ?? null,
    // Set when applying the proposal created a separate agent rather than
    // updating this one, so the card can still link to it after a reload.
    createdAgentId: metadata.createdAgentId ?? null,
  }
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  const agentId = agentIdFromRequest(request)
  await requireAgent(agentId, auth)
  const requested = new URL(request.url).searchParams.get('sessionId')

  // Resolve which conversation to return: explicit session, else the most
  // recent one, else the legacy flat thread (if any), else empty (new chat).
  let sessionId: string | null = requested
  if (!sessionId) {
    const latest = await prisma.agentChatSession.findFirst({
      where: { organizationId: auth.organizationId, agentTaskId: agentId, userId: auth.dbUser.id },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    })
    if (latest) {
      sessionId = latest.id
    } else {
      const legacyCount = await prisma.agentChatMessage.count({
        where: { organizationId: auth.organizationId, agentTaskId: agentId, userId: auth.dbUser.id, sessionId: null },
      })
      sessionId = legacyCount > 0 ? LEGACY_SESSION_ID : null
    }
  }

  let rows: AgentChatMessage[] = []
  if (sessionId) {
    rows = await prisma.agentChatMessage.findMany({
      where:
        sessionId === LEGACY_SESSION_ID
          ? { organizationId: auth.organizationId, agentTaskId: agentId, userId: auth.dbUser.id, sessionId: null }
          : { organizationId: auth.organizationId, agentTaskId: agentId, userId: auth.dbUser.id, sessionId },
      // Secondary id sort keeps user/assistant pairs stable when both rows land
      // in the same millisecond (cuids are creation-ordered within a process).
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    })
  }
  return { success: true, sessionId, messages: rows.reverse().map(serializeMessage) }
}, { permission: 'agent.read' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const agentId = agentIdFromRequest(request)
  const { message, sessionId: requestedSessionId } = z
    .object({ message: z.string().min(1).max(4000), sessionId: z.string().optional() })
    .parse(await request.json())
  const agent = await requireAgent(agentId, auth)

  // Provider check, per-user rate limit, and monthly ceiling — BEFORE the model
  // call below. The `agent-run:` limiter further down guards only the spawning
  // of a run, so until this was added the assistant's own model call was capped
  // by nothing tighter than the wrapper's 240 writes/min.
  await assertAiCallAllowed({
    organizationId: auth.organizationId,
    rateKey: `agent-chat:${auth.dbUser.id}`,
    limit: 20,
  })

  // Resolve the target conversation. An explicit, owned session is reused;
  // otherwise (absent, legacy, or unknown) a new session starts — the legacy
  // flat thread stays read-only history.
  let session =
    requestedSessionId && requestedSessionId !== LEGACY_SESSION_ID
      ? await prisma.agentChatSession.findFirst({
          where: { id: requestedSessionId, organizationId: auth.organizationId, agentTaskId: agentId, userId: auth.dbUser.id },
        })
      : null
  if (!session) {
    session = await prisma.agentChatSession.create({
      data: {
        agentTaskId: agentId,
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
        title: deriveTitle(message),
      },
    })
  }

  const [context, historyRows] = await Promise.all([
    buildAssistantContext(agent, message, auth.dbUser.id),
    prisma.agentChatMessage.findMany({
      where: { organizationId: auth.organizationId, agentTaskId: agentId, userId: auth.dbUser.id, sessionId: session.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
    }),
  ])
  const conversation = historyRows
    .reverse()
    .map((row) => ({ role: row.role, content: row.content.slice(0, 2000) }))

  let reply = ''
  let proposal: NormalizedProposal | null = null
  let runIntent: NormalizedRunIntent | null = null
  try {
    const text = await generateStructured({
      schemaName: 'assistant_reply',
      schema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
      system: `${SYSTEM_PROMPT}\n\n${UNTRUSTED_DATA_RULE}\n\n${GUARDRAIL_RULE}`,
      user: JSON.stringify({ context, conversation, question: message }),
      // Generous headroom: a reconfigure reply returns the agent's complete
      // instructions inline, which can be long — a tight cap truncates the JSON
      // and turns a valid answer into a parse failure.
      maxTokens: 8192,
      // Same 'run.chat' surface as /api/chat's follow-up Q&A — both are
      // interactive chat, and the /usage page's chat bucket keys on this
      // literal string (see src/lib/usage/chat-ledger.ts).
      ledger: buildChatLedgerContext({ organizationId: auth.organizationId, userId: auth.dbUser.id }),
    })
    const parsed = JSON.parse(text || '{}') as { reply?: unknown; proposal?: unknown; run?: unknown }
    reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : ''
    proposal = normalizeProposal(proposalSchema.catch(null).parse(parsed.proposal ?? null))
    runIntent = normalizeRunIntent(runIntentSchema.catch(null).parse(parsed.run ?? null))
    // Run and proposal are mutually exclusive; an action request wins over a
    // config card so "do X" never stalls behind a confirm button.
    if (runIntent) proposal = null
  } catch (error) {
    // Preserve the real cause so the 5xx handler logs/reports it — a bare catch
    // made this failure invisible in logs and Sentry.
    throw new ApiError('The assistant could not respond. Try again.', 502, 'ASSISTANT_FAILED', error)
  }
  if (!reply) reply = proposal ? 'Here is the proposed configuration change.' : runIntent ? 'Running the agent.' : 'No answer returned.'

  // A run intent executes the agent right here — the chat is the agent's front
  // end, so "do X" runs it with its own tools and skills (same engine as the
  // Run button) and the outcome becomes the reply. Failures land in the thread
  // as messages rather than 5xxs so the conversation can continue.
  let runMeta: { task: string; executionId?: string; status: string } | null = null
  if (runIntent) {
    // Same per-workspace cap as the manual execute route — chat must not be a
    // side door around it.
    const limited = await rateLimit(`agent-run:${auth.organizationId}`, { limit: 30, windowMs: 60_000 })
    if (!limited.ok) {
      reply = 'Too many agent runs started in the last minute — wait a moment and ask again.'
    } else {
      const execution = await prisma.agentExecution.create({
        data: {
          agentType: agent.agentType,
          agentTaskId: agent.id,
          status: 'pending',
          input: { prompt: runIntent.task },
          trigger: { type: 'manual', source: 'assistant' },
          metadata: { title: (agent.metadata as { title?: string } | null)?.title || agent.description },
          userId: auth.dbUser.id,
          organizationId: auth.organizationId,
        },
      })
      runMeta = { task: runIntent.task, executionId: execution.id, status: 'pending' }
      const markFailed = (detail: string) =>
        prisma.agentExecution
          .update({
            where: { id: execution.id, organizationId: auth.organizationId },
            data: { status: 'failed', error: detail.slice(0, 300), completedAt: new Date() },
          })
          .catch(() => undefined)
      if (inlineExecution) {
        try {
          const result = await runAgentExecution({
            executionId: execution.id,
            agentId: agent.id,
            organizationId: auth.organizationId,
            userId: auth.dbUser.id,
            input: runIntent.task,
          })
          const paused = result as { status?: string; question?: string }
          if (paused.status === 'waiting_for_input') {
            runMeta.status = 'waiting_for_input'
            reply = `The run paused with a question:\n\n> ${paused.question || 'It needs more input.'}\n\nOpen the run in the activity feed to answer it.`
          } else if (paused.status === 'waiting_for_approval') {
            runMeta.status = 'waiting_for_approval'
            reply = 'The run paused for an approval. Review it in the approvals queue to continue.'
          } else {
            runMeta.status = 'completed'
            const summary = (result as { summary?: string }).summary
            reply = summary?.trim() || 'The run finished but produced no output.'
          }
        } catch (error) {
          // The executor marks its own failures once the run is underway; this
          // also covers pre-run throws (e.g. a paused agent) that leave the row
          // pending.
          runMeta.status = 'failed'
          const detail = error instanceof Error ? error.message : String(error)
          reply = `The run failed: ${detail}`
          await markFailed(detail)
        }
      } else if (workersEnabled) {
        try {
          const queue = createQueue(QUEUE_NAMES.AGENT_EXECUTION)
          await queue.add(
            'execute-agent',
            injectTraceContext({ executionId: execution.id, agentId: agent.id, organizationId: auth.organizationId, userId: auth.dbUser.id, input: runIntent.task }),
            { jobId: execution.id },
          )
          reply = `${reply}\n\nThe run has started — its output will appear in the activity feed when it finishes.`
        } catch {
          runMeta.status = 'failed'
          reply = 'The run could not be queued — try again in a moment.'
          await markFailed('Unable to queue agent execution')
        }
      } else {
        runMeta.status = 'failed'
        reply = 'Runs are unavailable right now — the agent worker is disabled.'
        await markFailed('Agent worker is disabled')
      }
    }
  }

  // Persist only after the model answered, so a failed call leaves no
  // half-thread behind (the client restores the input for a retry).
  // Rough metering: generateStructured doesn't return token usage, so estimate
  // (~chars/4) to keep the month-to-date counter aware of assistant spend.
  void recordTokenUsage(
    auth.organizationId,
    Math.ceil((JSON.stringify(context).length + message.length + reply.length) / 4),
  ).catch(() => undefined)

  const userMessage = await prisma.agentChatMessage.create({
    data: {
      agentTaskId: agentId,
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      sessionId: session.id,
      role: 'user',
      content: message,
    },
  })
  const assistantMetadata: Record<string, unknown> = {}
  if (proposal) assistantMetadata.proposal = proposal
  if (runMeta) assistantMetadata.run = runMeta
  const assistantMessage = await prisma.agentChatMessage.create({
    data: {
      agentTaskId: agentId,
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      sessionId: session.id,
      role: 'assistant',
      content: reply,
      ...(Object.keys(assistantMetadata).length
        ? { metadata: assistantMetadata as unknown as Prisma.InputJsonValue }
        : {}),
    },
  })
  // Bump the session so it sorts to the top of history (and set its title on the
  // first message). Best-effort — ordering is cosmetic, not correctness.
  await prisma.agentChatSession
    .update({ where: { id: session.id }, data: { title: session.title ?? deriveTitle(message) } })
    .catch(() => undefined)

  return { success: true, sessionId: session.id, messages: [serializeMessage(userMessage), serializeMessage(assistantMessage)] }
}, { permission: 'agent.run' })

// Marks a proposal message as applied after the client has confirmed the
// change through the existing /api/agents endpoints — PUT for a change to this
// agent, POST (cloneFrom) when the proposal stood up a separate agent, whose id
// comes back as createdAgentId.
export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const agentId = agentIdFromRequest(request)
  const { messageId, createdAgentId } = z
    .object({ messageId: z.string().min(1), createdAgentId: z.string().min(1).optional() })
    .parse(await request.json())
  await requireAgent(agentId, auth)

  const row = await prisma.agentChatMessage.findFirst({
    where: { id: messageId, organizationId: auth.organizationId, agentTaskId: agentId, userId: auth.dbUser.id },
  })
  if (!row) throw new ApiError('Message not found', 404, 'NOT_FOUND')
  const metadata =
    row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {}
  const updated = await prisma.agentChatMessage.update({
    where: { id: row.id, organizationId: auth.organizationId },
    data: {
      metadata: {
        ...metadata,
        appliedAt: new Date().toISOString(),
        ...(createdAgentId ? { createdAgentId } : {}),
      } as unknown as Prisma.InputJsonValue,
    },
  })
  return { success: true, message: serializeMessage(updated) }
}, { permission: 'agent.write' })
