import { ApiError } from '@/lib/server/api-handler'
import { rateLimit } from '@/lib/ratelimit'
import { qwenConfigured } from '@/lib/llm/qwen'
import { checkMonthlyTokenBudget, recordTokenUsage } from '@/lib/usage/budget'
import { prisma } from '@/lib/prisma'
import { recordAudit } from '@/lib/audit'
import { detectPiiCategories, normalizeAiEgressPolicy } from '@/lib/security/pii-egress'

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
  if (!process.env.ANTHROPIC_API_KEY && !qwenConfigured()) {
    throw new ApiError('No model provider is configured', 503, 'AI_UNAVAILABLE')
  }
  // Workspace-level AI opt-out — the enforceable switch for customers whose
  // DPA forbids model processing. Checked before rate limiting so the refusal
  // message is about policy, not about pace.
  const organization = await prisma.organization.findFirst({
    where: { id: opts.organizationId },
    select: { aiEgressPolicy: true },
  })
  if (normalizeAiEgressPolicy(organization?.aiEgressPolicy) === 'blocked') {
    throw new ApiError(
      'This workspace has AI processing disabled by policy. An administrator can change this in workspace settings.',
      403,
      'AI_EGRESS_BLOCKED',
    )
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
  void recordTokenUsage(organizationId, Math.ceil(chars / 4)).catch(() => undefined)
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
  } catch {
    /* the record must never block the call */
  }
}
