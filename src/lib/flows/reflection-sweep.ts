import { z } from 'zod'
import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { generateStructured, DEFAULT_SUMMARY_MODEL } from '@/lib/llm/model-runner'
import { detectFailurePatterns, type PatternRun, type FailurePattern } from '@/lib/flows/failure-patterns'

/**
 * Flow reflection.
 *
 * Agents have reflected since day one (execute-agent.ts calls
 * reflectAndRemember); flows never did. A flow that failed the same way every
 * 15 minutes produced 96 identical failed runs a day and no proposal, no
 * checker rule, nothing.
 *
 * PATTERN-triggered, not per-run: one structured call per flow that has a
 * pattern, at most once a day. Cost is O(flows with a pattern), not O(runs) —
 * and a single run could not see a trend anyway.
 *
 * The output is a `process_improvement` TemplateProposal, which already has
 * accept/dismiss wired end to end. That decision is also the outcome signal the
 * agent memory loop never had: AgentMemory.timesUsed counts recurrence and
 * retrieval, never whether a learning actually helped.
 */

/** One proposal per flow per day. */
export const REFLECTION_DEBOUNCE_MS = 24 * 60 * 60 * 1000
/** Bound the model spend of a single tick. */
export const MAX_REFLECTIONS_PER_TICK = 5
/** How recently a failure must have occurred for the flow to be a candidate. */
const CANDIDATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** How many recent runs the detector reasons over. */
const RUN_WINDOW = 10
/** Backstop on the candidate scan; far above any real per-tick volume. */
const MAX_CANDIDATES = 500

const reflectionSchema = z.object({ title: z.string().min(1), rationale: z.string().min(1) })

const REFLECTION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { title: { type: 'string' }, rationale: { type: 'string' } },
  required: ['title', 'rationale'],
}

/** FlowRunStep.warnings is Json; the detector wants string[]. */
function warningsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

export function buildReflectionPrompt(flowName: string, pattern: FailurePattern): { system: string; user: string } {
  return {
    system:
      'You review automation run history. Given one recurring failure pattern in a workflow, write a short title naming what is wrong and a rationale explaining the likely cause and the fix. Be concrete and terse. Write plain English only: never output cron expressions, curly-brace token syntax, or code identifiers the user did not write themselves.',
    user: [
      `Workflow: ${flowName}`,
      `Step: ${pattern.stepId}`,
      `Signal: ${pattern.kind === 'error' ? 'the step failed' : 'the step warned'}`,
      `Recurring message: ${pattern.signature}`,
      `Seen ${pattern.occurrences} times across ${pattern.runIds.length} runs, from ${pattern.firstSeen.toISOString()} to ${pattern.lastSeen.toISOString()}.`,
    ].join('\n'),
  }
}

/**
 * Returns the flow ids that produced a proposal. NEVER throws — a reflection
 * failure must not abort the dispatch tick that calls it.
 */
export async function sweepFlowReflection(
  now: Date,
  deps: { generate?: typeof generateStructured } = {},
): Promise<string[]> {
  const generate = deps.generate ?? generateStructured
  const reflected: string[] = []

  // Candidate scan: only flows with a FAILED run recently. Scanning every flow
  // and loading its history would make this the most expensive thing in the
  // tick.
  // systemPrisma: cross-org sweep by design (the caller is CRON_SECRET-gated).
  const candidates = await systemPrisma.flowRun.findMany({
    where: { status: 'failed', startedAt: { gte: new Date(now.getTime() - CANDIDATE_WINDOW_MS) } },
    select: { flowId: true },
    distinct: ['flowId'],
    take: MAX_CANDIDATES,
  })

  for (const { flowId } of candidates) {
    if (reflected.length >= MAX_REFLECTIONS_PER_TICK) break
    try {
      // systemPrisma: the candidate list is already cross-org; this resolves the
      // org each proposal is then written into.
      const flow = await systemPrisma.flow.findUnique({
        where: { id: flowId },
        select: { id: true, name: true, organizationId: true, userId: true },
      })
      if (!flow) continue

      // Debounce off the proposals themselves — they ARE the ledger, the same
      // reasoning as generation-queue.ts's readLastGeneratedAt. No marker table.
      const recent = await prisma.templateProposal.findFirst({
        where: {
          organizationId: flow.organizationId,
          kind: 'process_improvement',
          createdAt: { gte: new Date(now.getTime() - REFLECTION_DEBOUNCE_MS) },
          configuration: { path: ['targetId'], equals: flow.id },
        },
        select: { id: true },
      })
      if (recent) continue

      // systemPrisma: reading one flow's own run history, resolved above.
      const runs = await systemPrisma.flowRun.findMany({
        where: { flowId: flow.id },
        orderBy: { startedAt: 'desc' },
        take: RUN_WINDOW,
        select: {
          id: true,
          startedAt: true,
          steps: { select: { nodeId: true, status: true, error: true, warnings: true } },
        },
      })

      const patternRuns: PatternRun[] = runs.map((source) => ({
        id: source.id,
        startedAt: source.startedAt,
        steps: source.steps.map((step) => ({
          nodeId: step.nodeId,
          status: step.status,
          error: step.error,
          warnings: warningsOf(step.warnings),
        })),
      }))

      const patterns = detectFailurePatterns(patternRuns)
      if (!patterns.length) continue
      // Top pattern only — one proposal per flow per day, not one per pattern.
      const pattern = patterns[0]

      const { system, user } = buildReflectionPrompt(flow.name, pattern)
      const raw = await generate({
        system,
        user,
        schema: REFLECTION_JSON_SCHEMA,
        schemaName: 'flow_reflection',
        maxTokens: 800,
        model: process.env.FLOW_REFLECTION_MODEL?.trim() || DEFAULT_SUMMARY_MODEL,
      })

      let parsed
      try {
        parsed = reflectionSchema.safeParse(JSON.parse(raw))
      } catch {
        continue
      }
      if (!parsed.success) continue

      await prisma.templateProposal.create({
        data: {
          organizationId: flow.organizationId,
          userId: flow.userId,
          kind: 'process_improvement',
          title: parsed.data.title.slice(0, 200),
          rationale: parsed.data.rationale.slice(0, 2000),
          // targetType/targetId is exactly what proposalImprovementTarget reads
          // (src/lib/templates/accept-proposal.ts) — accepting opens the flow
          // editor on the offending flow. Extra keys are ignored by that path.
          configuration: { targetType: 'flow', targetId: flow.id, stepId: pattern.stepId },
          sourceEvidence: {
            stepId: pattern.stepId,
            kind: pattern.kind,
            signature: pattern.signature,
            occurrences: pattern.occurrences,
            runIds: pattern.runIds.slice(0, 10),
            firstSeen: pattern.firstSeen.toISOString(),
            lastSeen: pattern.lastSeen.toISOString(),
          },
        },
      })
      reflected.push(flow.id)
    } catch (error) {
      // Per-flow isolation, mirroring reflectAndRemember: one bad flow never
      // stops the sweep, and the sweep never throws at its caller.
      apiLogger.warn('flow reflection failed for one flow', {
        flowId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return reflected
}
