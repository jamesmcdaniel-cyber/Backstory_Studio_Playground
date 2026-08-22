import { GUARDRAIL_RULE } from '@/lib/security/guardrails'
import { UNTRUSTED_DATA_RULE } from '@/lib/security/prompt'
import { z } from 'zod'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'
import { generateStructured } from '@/lib/llm/model-runner'
import { flowGraphSchema, emptyGraph } from '@/lib/flows/graph'
import { validateFlowGraph } from '@/lib/flows/validate'
import { buildCopilotGrounding } from '@/lib/flows/copilot-grounding'
import { applyCopilotOps } from '@/lib/flows/copilot-ops'
import { parseCopilotChatReply, sanitizeCopilotOps, discardNotice } from '@/lib/flows/copilot-chat'
import { assertAiCallAllowed, recordEstimatedUsage } from '@/lib/usage/ai-guard'
import { buildChatLedgerContext } from '@/lib/usage/chat-ledger'

// Anthropic strict structured outputs can't express free-form objects (a
// {type:'object'} with no declared properties — see strictifySchema and the
// sibling generate route's graphJson rationale), and the six op shapes are too
// heterogeneous to enumerate strictly. So, same wrapper pattern as generation:
// the model returns the ops ARRAY as a JSON STRING and we parse it ourselves.
const OPS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    message: {
      type: 'string',
      description: 'A short, friendly explanation of what you changed or what you need, mentioning node labels.',
    },
    opsJson: {
      type: 'string',
      description: 'A JSON string containing an ARRAY of edit-op objects. Use "[]" when making no changes.',
    },
  },
  required: ['message', 'opsJson'],
  additionalProperties: false,
}

const OPS_CONTRACT = [
  'EDIT OPERATIONS',
  'You are editing an existing flow conversationally. The graph shape rules above govern node/edge CONTENT (including the graph inside a replace op); your reply itself must be a single JSON object {"message": string, "opsJson": string} where opsJson is a JSON string containing an ARRAY of edit operations (use "[]" when you change nothing).',
  'The six allowed operations:',
  '- {"op": "add", "type": "agent" | "condition" | "loop" | "parallel" | "stop" | "tool" | "http" | "transform" | "filter" | "switch" | "variable" | "data" | "humanReview" | "output" | "join" | "ai" | "subflow" | "knowledge", "afterId": "<existing node id>", "agentId": "<roster agent id, agent steps only>", "data": { ...node data fields... }} — insert a new step after afterId.',
  '- {"op": "update", "id": "<node id>", "data": { ...fields to merge... }} — shallow-merge data into an existing step.',
  '- {"op": "delete", "id": "<node id>"} — remove a step.',
  '- {"op": "move", "id": "<node id>", "afterId": "<node id>"} — move a step to sit after another.',
  '- {"op": "setTrigger", "trigger": { ...trigger config fields... }} — merge changes into the trigger configuration.',
  '- {"op": "replace", "graphJson": "<the complete flow graph as a JSON string, same shape rules as generation>"} — replace the entire flow.',
  'Prefer minimal targeted ops over replace. Use replace ONLY when building a brand-new flow or when the user explicitly asks for a full redesign.',
  'When the request is ambiguous or impossible with these operations, return opsJson "[]" and ask ONE clarifying question in message.',
  'Always explain what you did or what you need in message, mentioning node labels.',
  'FIXING BLOCKERS',
  'When the current flow has validation issues (listed with the graph), treat fixing them as part of your job: fix what a targeted op can fix without being asked twice, and when the user asks to run, publish, or unblock the flow, fix the blockers first.',
  'An http step "without authentication" is fixed with an update op setting data.credentialId to a listed HTTP credential whose host matches the step URL (or data.connectionId to a listed MCP connection for that provider — never set both). If the credential list has no match, do not invent one: say exactly what to do — connect the provider under Integrations, or create an HTTP credential for that host from the step\'s Auth settings.',
  'A step "not connected to the trigger" is fixed with a move op (or by adding the missing edge via the graph rules) so the step sits on a path from the trigger.',
].join('\n')

const requestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().transform((content) => content.slice(0, 4000)),
      }),
    )
    .min(1)
    .max(20),
  graph: z.unknown(),
  // Set by the builder when the caller is a cross-workspace guest on a shared
  // flow: grounding goes structure-only (no roster/tools — see
  // buildCopilotGrounding). Client-declared, but over-claiming only REDUCES
  // what Copilot can reference, so it needs no server-side verification.
  external: z.boolean().optional(),
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { messages, graph: rawGraph, external } = requestSchema.parse(await request.json())
  // Gate before any model spend: provider, per-user rate limit, monthly ceiling.
  await assertAiCallAllowed({ organizationId: auth.organizationId, rateKey: `flow-copilot-chat:${auth.dbUser.id}`, limit: 20 })
  const { roster, toolCatalog, httpCredentials, contextBlock, graphRules } = await buildCopilotGrounding(auth.organizationId, auth.dbUser.id, {
    structureOnly: external === true,
  })

  // An invalid/missing graph means we're chatting over a blank canvas.
  const parsedGraph = flowGraphSchema.safeParse(rawGraph)
  const graph = parsedGraph.success ? parsedGraph.data : emptyGraph()

  const validationContext = {
    agents: roster.map((agent) => ({ id: agent.id, title: agent.name })),
    toolCatalog,
    httpCredentials,
  }
  // The copilot sees what the checker sees: current issues ride along with the
  // graph so it can offer (and apply) fixes instead of editing blind.
  const currentIssues = graph.nodes.length > 1 ? validateFlowGraph(graph, validationContext).issues : []
  const issueLines = currentIssues
    .slice(0, 20)
    .map((issue) => `- [${issue.level}] ${issue.code}${issue.nodeId ? ` at node ${issue.nodeId}` : ''}: ${issue.message}`)

  const system = [graphRules, '', OPS_CONTRACT, '', contextBlock, '', UNTRUSTED_DATA_RULE, '', GUARDRAIL_RULE].join('\n')
  const transcript = messages.map((entry) => `${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.content}`).join('\n\n')
  const user = [
    `Current flow graph JSON:\n${JSON.stringify(graph)}`,
    '',
    ...(issueLines.length ? [`Current validation issues:\n${issueLines.join('\n')}`, ''] : []),
    `Conversation so far:\n${transcript}`,
    '',
    'Respond to the latest user message.',
  ].join('\n')

  try {
    const raw = await generateStructured({
      system,
      user,
      schema: OPS_JSON_SCHEMA,
      schemaName: 'flow_edit_ops',
      maxTokens: 3500,
      // Same 'run.chat' surface as /api/chat and the per-agent assistant
      // thread — all three are interactive chat, and the /usage page's chat
      // bucket keys on this literal string (see src/lib/usage/chat-ledger.ts).
      ledger: buildChatLedgerContext({ organizationId: auth.organizationId, userId: auth.dbUser.id }),
    })
    recordEstimatedUsage(auth.organizationId, system, user, raw)
    const reply = parseCopilotChatReply(raw)
    const { ops, discarded } = sanitizeCopilotOps(reply.candidates, { agents: roster, toolCatalog })
    const totalDiscarded = discarded + (reply.opsUnreadable ? 1 : 0)

    // Apply the sanitized ops server-side so needsAttention reflects the
    // post-edit state the client will land on — and so the fallback message
    // is honest about whether anything actually applied.
    const applied = applyCopilotOps(graph, ops)
    const baseMessage =
      reply.message ||
      (ops.length === 0
        ? 'I could not work out a change to make — could you rephrase?'
        : applied.applied === 0
          ? 'I could not apply those changes — the targets may no longer exist.'
          : 'I applied the requested changes.')
    let message = totalDiscarded > 0 ? baseMessage + discardNotice(totalDiscarded) : baseMessage
    // Fires even when nothing applied but the model supplied its own (possibly
    // optimistic) message — the applied===0 fallback only covers the no-message case.
    if (applied.skipped.length > 0 && (applied.applied > 0 || reply.message)) {
      message += ` (${applied.skipped.length} change${applied.skipped.length === 1 ? '' : 's'} could not be applied.)`
    }
    const validation = validateFlowGraph(applied.graph, {
      ...validationContext,
      requireRunnable: applied.graph.nodes.length > 1,
    })
    const needsAttention = [...validation.errors, ...validation.warnings].map((issue) => ({ nodeId: issue.nodeId, message: issue.message }))

    return { success: true, message, ops, needsAttention }
  } catch (error) {
    // Same reasoning as /api/flows/copilot: only unexpected failures reach here,
    // and their messages are internal detail rather than user guidance.
    apiLogger.error('flow copilot chat failed', {
      organizationId: auth.organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
    captureError(error, { path: '/api/flows/copilot/chat' })
    return {
      success: false,
      error: 'Could not apply that change. Try rephrasing what you want.',
    }
  }
}, { permission: 'flow.write' })
