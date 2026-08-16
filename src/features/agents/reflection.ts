import { UNTRUSTED_DATA_RULE } from '@/lib/security/prompt'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { generateStructured, DEFAULT_SUMMARY_MODEL } from '@/lib/llm/model-runner'
import { saveAgentMemory } from '@/lib/memory/agent-memory'
import type { NodeVisibility } from '@/lib/rag/store'

const ACTION_TYPES = ['connect', 'config', 'data', 'other'] as const

const reflectionSchema = z.object({
  learnings: z.array(z.object({ title: z.string(), content: z.string() })).default([]),
  selfCritique: z.string().default(''),
  suggestions: z
    .array(
      z.object({
        title: z.string(),
        rationale: z.string(),
        actionType: z
          .string()
          .optional()
          .transform((value) => (value && ACTION_TYPES.includes(value as (typeof ACTION_TYPES)[number]) ? (value as (typeof ACTION_TYPES)[number]) : 'other')),
      }),
    )
    .default([]),
  goalAssessment: z.string().default(''),
  suggestedGoal: z.string().optional(),
})

export type Reflection = z.infer<typeof reflectionSchema>

export const REFLECTION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    learnings: {
      type: 'array',
      items: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } }, required: ['title', 'content'] },
    },
    selfCritique: { type: 'string' },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, rationale: { type: 'string' }, actionType: { type: 'string', enum: [...ACTION_TYPES] } },
        required: ['title', 'rationale'],
      },
    },
    goalAssessment: { type: 'string' },
    suggestedGoal: { type: 'string' },
  },
  required: ['learnings', 'selfCritique', 'suggestions', 'goalAssessment'],
}

/** Tolerant parse: strip fences, find the object, validate. Null on garbage. */
export function parseReflection(raw: string): Reflection | null {
  const trimmed = raw.trim()
  const candidates = [trimmed]
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidates.push(fence[1].trim())
  const braces = trimmed.match(/\{[\s\S]*\}/)
  if (braces) candidates.push(braces[0])
  for (const candidate of candidates) {
    try {
      const result = reflectionSchema.safeParse(JSON.parse(candidate))
      if (result.success) return result.data
    } catch {
      /* try next */
    }
  }
  return null
}

export function buildReflectionPrompt(params: {
  goal: string | null
  objective: string
  summary: string
  processLog: string
}): { system: string; user: string } {
  return {
    system:
      UNTRUSTED_DATA_RULE +
      '\n\nYou are the reflection pass for an autonomous agent. Given a completed run, extract durable learnings (facts about where data lives, what worked, what failed), one short self-critique paragraph the agent should read before its next run, and up to 3 user-actionable suggestions that would help future runs serve the larger goal better (missing connections, data gaps, objective improvements). Be concrete and terse. If no goal was provided, infer one from the objective and return it as suggestedGoal.',
    user: [
      `Larger goal: ${params.goal ?? '(none provided — infer one)'}`,
      `Objective: ${params.objective}`,
      `Run summary:\n${params.summary.slice(0, 6000)}`,
      `Process log (condensed):\n${params.processLog.slice(0, 6000)}`,
    ].join('\n\n'),
  }
}

/**
 * Post-run reflection: one structured LLM call, then persist learnings /
 * critique / suggestions as agent memories and emit suggestion events.
 * Fire-and-forget by callers; never throws.
 */
export async function reflectAndRemember(
  params: {
    organizationId: string
    agentId: string
    executionId: string
    goal: string | null
    objective: string
    summary: string
    processLog: string
    ownerUserId?: string | null
    visibility?: NodeVisibility
    recordSuggestionEvent: (payload: Record<string, unknown>) => Promise<void>
  },
  deps: { generate?: typeof generateStructured } = {},
): Promise<Reflection | null> {
  try {
    const generate = deps.generate ?? generateStructured
    const { system, user } = buildReflectionPrompt(params)
    // Reflection is a background, non-user-facing pass — run it on the cheap
    // model tier (env-overridable) rather than the full agent model.
    const model = process.env.AGENT_REFLECTION_MODEL?.trim() || DEFAULT_SUMMARY_MODEL
    const raw = await generate({ system, user, schema: REFLECTION_JSON_SCHEMA, schemaName: 'agent_reflection', maxTokens: 1500, model })
    const reflection = parseReflection(raw)
    if (!reflection) return null

    for (const learning of reflection.learnings.slice(0, 5)) {
      await saveAgentMemory({
        organizationId: params.organizationId,
        agentId: params.agentId,
        kind: 'learning',
        title: learning.title,
        content: learning.content,
        sourceExecutionId: params.executionId,
        ownerUserId: params.ownerUserId ?? null,
        visibility: params.visibility,
      })
    }

    const critique = reflection.selfCritique.trim()
    if (critique || reflection.suggestedGoal) {
      // The latest critique is ALWAYS injected next run — store it on the task
      // metadata (single slot), not as an accumulating memory row. A proposed
      // goal must persist even when there's no critique this run.
      //
      // This runs fire-and-forget AFTER the run completes, and metadata is the
      // agent's LIVE config (model, skills, maxTurns, requireApproval, …). A
      // read-modify-write of the whole blob here would silently revert any edit
      // the user made while the run was in flight — so patch ONLY our own keys
      // atomically with jsonb_set, never rewriting the object. (goal is a scalar
      // column; reading it does not participate in the clobber.)
      const agent = await prisma.agentTask.findFirst({
        where: { id: params.agentId, organizationId: params.organizationId },
        select: { goal: true },
      })
      let expr = Prisma.sql`COALESCE(metadata, '{}'::jsonb)`
      if (critique) {
        expr = Prisma.sql`jsonb_set(${expr}, '{lastCritique}', to_jsonb(${critique.slice(0, 1500)}::text))`
      }
      if (reflection.suggestedGoal && !agent?.goal) {
        expr = Prisma.sql`jsonb_set(${expr}, '{suggestedGoal}', to_jsonb(${reflection.suggestedGoal.slice(0, 500)}::text))`
      }
      await prisma.$executeRaw`
        UPDATE agent_tasks SET metadata = ${expr}
        WHERE id = ${params.agentId} AND "organizationId" = ${params.organizationId}::uuid
      `
    }

    for (const suggestion of reflection.suggestions.slice(0, 3)) {
      const saved = await saveAgentMemory({
        organizationId: params.organizationId,
        agentId: params.agentId,
        kind: 'suggestion',
        title: suggestion.title,
        content: suggestion.rationale,
        sourceExecutionId: params.executionId,
        ownerUserId: params.ownerUserId ?? null,
        visibility: params.visibility,
      })
      if (saved) {
        await params
          .recordSuggestionEvent({
            memoryId: saved.id,
            deduped: saved.deduped,
            title: suggestion.title,
            rationale: suggestion.rationale,
            actionType: suggestion.actionType ?? 'other',
          })
          .catch(() => undefined)
      }
    }

    return reflection
  } catch (error) {
    apiLogger.warn('reflectAndRemember failed', { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}
