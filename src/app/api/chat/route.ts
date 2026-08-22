import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { DEFAULT_SUMMARY_MODEL } from '@/lib/llm/model-runner'
import { qwenClient, qwenModel } from '@/lib/llm/qwen'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { executionVisibilityScope } from '@/lib/server/visibility'
import { fenceUntrusted, UNTRUSTED_DATA_RULE } from '@/lib/security/prompt'
import { assertAiCallAllowed, recordPiiEgress } from '@/lib/usage/ai-guard'
import { recordTokenUsage } from '@/lib/usage/budget'
import { recordLlmCall } from '@/lib/usage/ledger'
import { buildChatLedgerContext } from '@/lib/usage/chat-ledger'

// The run record folded into the prompt below carries whatever the agent's
// tools returned — email bodies, ticket text, fetched pages. That is
// attacker-influenceable content, so the rule travels with the prompt.
const SYSTEM_PROMPT = [
  'Answer questions about an AI agent run. Be precise about its output, tool calls, and errors. Do not claim actions not present in the run data.',
  UNTRUSTED_DATA_RULE,
].join('\n\n')

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { executionId, question } = z.object({
    executionId: z.string().min(1),
    question: z.string().min(1).max(4000),
  }).parse(await request.json())
  // Gate before model spend: provider, per-user rate limit, monthly ceiling.
  await assertAiCallAllowed({ organizationId: auth.organizationId, rateKey: `run-chat:${auth.dbUser.id}`, limit: 20 })

  const execution = await prisma.agentExecution.findFirst({
    where: { id: executionId, organizationId: auth.organizationId, ...executionVisibilityScope(auth.dbUser.id) },
    include: { workflowSteps: true, messages: { orderBy: { createdAt: 'asc' } } },
  })
  if (!execution) throw new ApiError('Execution not found', 404, 'NOT_FOUND')

  // The raw model transcript is large and internal; answer from the run record.
  const run = { ...execution, transcript: undefined }
  // The user's question stays outside the fence (it IS the instruction); the
  // run record goes inside it (it is evidence, and it is not the user's text).
  const prompt = [
    `Question: ${question}`,
    '',
    fenceUntrusted('agent run record', JSON.stringify(run)),
  ].join('\n')

  // Recorded here rather than at the shared structured-call seam in
  // lib/llm/model-runner.ts, which records for every other interactive endpoint:
  // this one calls the Messages API directly and so never passes through it.
  void recordPiiEgress({ organizationId: auth.organizationId, userId: auth.dbUser.id, surface: 'run.chat', text: prompt })

  // Both endpoints speak the Anthropic Messages API. Prefer Claude when its key
  // is present; otherwise use Qwen (DashScope's Anthropic-compatible endpoint).
  const useClaude = Boolean(process.env.ANTHROPIC_API_KEY)
  const client = useClaude ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : qwenClient()
  const model = useClaude
    ? (DEFAULT_SUMMARY_MODEL.startsWith('claude') ? DEFAULT_SUMMARY_MODEL : 'claude-haiku-4-5')
    : qwenModel(DEFAULT_SUMMARY_MODEL.startsWith('claude') ? 'qwen-3.7' : DEFAULT_SUMMARY_MODEL)

  const startedAt = Date.now()
  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  })
  // Real usage counts here (the SDK returns them) — record against the ceiling.
  void recordTokenUsage(
    auth.organizationId,
    (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
  ).catch(() => undefined)
  // recordTokenUsage above is the Redis budget counter (separate by design);
  // this is the LlmCall ledger — admin costs, per-user usage, and the
  // /usage page's chat bucket all read from it, and until now this surface
  // never wrote a row here because it calls the Messages API directly rather
  // than through lib/llm/model-runner's shared ledger seam.
  void recordLlmCall({
    ...buildChatLedgerContext({ organizationId: auth.organizationId, userId: auth.dbUser.id }),
    provider: useClaude ? 'anthropic' : 'qwen',
    model,
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      cacheWriteTokens: response.usage?.cache_creation_input_tokens ?? 0,
      cacheReadTokens: response.usage?.cache_read_input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    },
    latencyMs: Date.now() - startedAt,
    agentExecutionId: executionId,
  }).catch(() => undefined)
  const answer = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
  return { success: true, answer: answer || 'No answer returned.' }
}, { permission: 'agent.run' })
