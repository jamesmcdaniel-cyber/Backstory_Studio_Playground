import { ApiError } from '@/lib/server/api-handler'
import { rateLimit } from '@/lib/ratelimit'
import { checkMonthlyTokenBudget, recordTokenUsage } from '@/lib/usage/budget'
import { prisma } from '@/lib/prisma'
import { recordAudit } from '@/lib/audit'
import { apiLogger } from '@/lib/logger'
import {
  AI_EGRESS_BLOCKED_MESSAGE,
  AiEgressBlockedError,
  type AiEgressPolicy,
  detectPiiCategories,
  normalizeAiEgressPolicy,
} from '@/lib/security/pii-egress'

/**
 * The workspace's AI egress policy — one indexed read of the org row.
 *
 * Its own function so the interactive gate below and the run-time gate used by
 * the agent/flow runtimes read the SAME column through the SAME normalization.
 * An unrecognised value means 'allowed' (see normalizeAiEgressPolicy).
 */
export async function loadAiEgressPolicy(organizationId: string): Promise<AiEgressPolicy> {
  const organization = await prisma.organization.findFirst({
    where: { id: organizationId },
    select: { aiEgressPolicy: true },
  })
  return normalizeAiEgressPolicy(organization?.aiEgressPolicy)
}

/**
 * The workspace AI opt-out, for the NON-interactive egress paths: agent runs and
 * flow AI steps. Those two carry the overwhelming majority of the prompts this
 * platform sends, and until this existed they only RECORDED what crossed —
 * a workspace switched to 'blocked' still shipped every run's tenant data to the
 * model provider, which is precisely the guarantee the switch is sold on.
 *
 * Returns the error to surface when the workspace is blocked, or null when the
 * call may proceed. Non-throwing because the two callers surface failure
 * differently — the agent runtime throws into its failure handler, a flow step
 * resolves as a failed step — and both must get the same sentence either way.
 *
 * The refusal is audit-logged before it is returned, mirroring the
 * `guardrail.refusal` row the agent loop writes: a policy that silently drops
 * work is indistinguishable from an outage, and "how much did this switch stop
 * last month" has to be a queryable question, not a guess.
 */
export async function aiEgressRefusal(opts: {
  organizationId: string
  userId?: string | null
  /** Which surface was about to send, e.g. 'agent.run', 'flow.ai_step'. */
  surface: string
  resourceType?: string
  resourceId?: string | null
}): Promise<AiEgressBlockedError | null> {
  if ((await loadAiEgressPolicy(opts.organizationId)) === 'allowed') return null
  // recordAudit absorbs its own write failures (logging them), so the refusal
  // below happens whether or not the row lands.
  await recordAudit({
    organizationId: opts.organizationId,
    action: 'ai.egress_blocked',
    actorUserId: opts.userId ?? null,
    actorKind: 'system',
    resourceType: opts.resourceType ?? 'model_call',
    resourceId: opts.resourceId ?? null,
    detail: { surface: opts.surface },
  })
  return new AiEgressBlockedError()
}

/**
 * Preflight for authenticated, interactive LLM endpoints (copilot generate/chat,
 * per-run Q&A chat, AI search). These call the model directly and so bypass the
 * agent-run budget path — this is where their spend is gated. Enforces, in order:
 *
 *   1. a model provider is configured (else 503 AI_UNAVAILABLE),
 *   2. the caller is under their per-minute rate limit (else 429 RATE_LIMITED),
 *   3. the workspace is under its monthly token ceiling (else 429 BUDGET_EXCEEDED).
 *
 * Throws ApiError on any gate — call it BEFORE spending any tokens. Pair with
 * recordEstimatedUsage after the call so repeated use actually trips the ceiling.
 */
export async function assertAiCallAllowed(opts: {
  organizationId: string
  /** Rate-limit bucket, typically `<feature>:<userId>`. */
  rateKey: string
  /** Max calls per window. */
  limit: number
  /** Window length; defaults to 60s. */
  windowMs?: number
}): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new ApiError('No model provider is configured', 503, 'AI_UNAVAILABLE')
  }
  // Workspace-level AI opt-out — the enforceable switch for customers whose
  // DPA forbids model processing. Checked before rate limiting so the refusal
  // message is about policy, not about pace.
  if ((await loadAiEgressPolicy(opts.organizationId)) === 'blocked') {
    throw new ApiError(AI_EGRESS_BLOCKED_MESSAGE, 403, 'AI_EGRESS_BLOCKED')
  }
  const limited = await rateLimit(opts.rateKey, { limit: opts.limit, windowMs: opts.windowMs ?? 60_000 })
  if (!limited.ok) {
    throw new ApiError('You’re sending requests too quickly — give it a few seconds.', 429, 'RATE_LIMITED')
  }
  const budget = await checkMonthlyTokenBudget(opts.organizationId)
  if (budget.over) {
    throw new ApiError('Monthly token budget reached for this workspace.', 429, 'BUDGET_EXCEEDED')
  }
}

/**
 * Best-effort token metering for endpoints whose model helper returns no usage
 * counts. Estimates ~chars/4 across the given input+output strings and adds it
 * to the month-to-date counter so interactive LLM spend still counts toward the
 * ceiling. Never throws. (When the SDK returns real usage, record that instead.)
 */
export function recordEstimatedUsage(
  organizationId: string,
  ...parts: Array<string | null | undefined>
): void {
  const chars = parts.reduce((sum, part) => sum + (part ? part.length : 0), 0)
  if (chars <= 0) return
  // A guess, not a provider-reported count — lands in the sibling `:est` Redis
  // key (see recordTokenUsage) so it never blends into the measured number a
  // surface might show, while still counting toward enforcement.
  void recordTokenUsage(organizationId, Math.ceil(chars / 4), { estimated: true }).catch(() => undefined)
}


/**
 * Record which PII categories a model-bound prompt carried, before it leaves.
 *
 * Category presence only, never values — recording the values would build a
 * second copy of the PII inside the audit log, creating the problem it
 * documents. One row per call that carried anything; silent when clean, so the
 * signal stays legible.
 *
 * Best-effort by contract: a recording failure must never block the call, or a
 * database blip turns into a total AI outage. The call was already admitted by
 * the policy gate above; this is the record, not the gate.
 */
export async function recordPiiEgress(opts: {
  organizationId: string
  userId?: string | null
  /** Which surface sent it, e.g. 'agent.run', 'flows.copilot'. */
  surface: string
  /** The model-bound text (system + user), scanned bounded. */
  text: string
}): Promise<void> {
  try {
    const categories = detectPiiCategories(opts.text)
    if (categories.length === 0) return
    await recordAudit({
      organizationId: opts.organizationId,
      action: 'ai.pii_egress',
      actorUserId: opts.userId ?? null,
      actorKind: 'system',
      resourceType: 'model_call',
      detail: { surface: opts.surface, categories, chars: opts.text.length },
    })
  } catch (error) {
    // Still non-blocking — but no longer invisible. A bare swallow meant the one
    // failure mode that matters here (recording broken for days, so the audit
    // trail the DPA answer is built from has a hole in it) looked exactly like
    // "no PII crossed". Warn so it shows up in the platform log.
    apiLogger.warn('ai-guard: could not record PII egress', {
      organizationId: opts.organizationId,
      surface: opts.surface,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
