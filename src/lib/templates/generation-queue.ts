/**
 * The GATED, cost-bounded generation job for sub-project C: it decides WHEN to
 * run `generateTemplateProposals` (Task 2, the expensive part) and enqueues it
 * on the `TEMPLATE_GENERATION` queue — or runs it inline when workers are off.
 *
 * Two triggers feed it, both routed through the same pure debounce decision so
 * neither can spam the model or the review queue:
 *  - `maybeGenerateOnGateClear(orgId)` — call when an org's 3rd integration
 *    connects (the gate first clears). One generation, only if none is open and
 *    none ran recently.
 *  - `sweepTemplateGeneration(now)` — the daily cron sweep (see cron/dispatch),
 *    per org, capped, debounced.
 *
 * DEBOUNCE / cost bounds:
 *  - `shouldGenerateNow` gates on the org gate + an open-proposal guard (never
 *    pile a second batch on an unreviewed one) + a `GENERATION_DEBOUNCE_MS`
 *    window (at most ~once/day per org — the "daily" in daily sweep).
 *  - `lastGeneratedAt` is derived from the org's NEWEST `TemplateProposal.createdAt`
 *    (the proposals ARE the generation ledger — no extra marker table needed). A
 *    org that has never generated has `null` and is eligible immediately.
 *
 * TENANT SAFETY: every per-org read (`countConnectedIntegrations`,
 * `listOpenProposals`, `readLastGeneratedAt`) carries `organizationId`; the cron
 * sweep's ONLY cross-org read is the org-id list (systemPrisma, CRON_SECRET-gated).
 */

import type { Job } from 'bullmq'
import { prisma, systemPrisma } from '@/lib/prisma'
import { createQueue, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { inlineExecution } from '@/lib/queue/execution-mode'
import {
  countConnectedIntegrations,
  meetsTemplateGate,
} from '@/lib/integrations/integration-count'
import { listOpenProposals } from '@/lib/templates/proposals'
import { generateTemplateProposals, ORG_GATE_USER_ID } from '@/lib/templates/generate-proposals'
import { apiLogger } from '@/lib/logger'
import { isCustomerEdition } from '@/lib/edition'

/** The payload the worker (and inline path) run generation for. */
export type TemplateGenerationJob = { organizationId: string }

export type GenerationResult = { written: number; skipped: string | null }

/**
 * Don't regenerate for the same org more often than this. ~20h (not a full 24h)
 * so a daily cron tick that drifts an hour or two still fires each calendar day.
 */
export const GENERATION_DEBOUNCE_MS = 20 * 60 * 60 * 1000

/**
 * How long an unreviewed inbox may block regeneration. Past this, generation
 * resumes even with open proposals so a user who never clears their inbox still
 * gets suggestions reflecting newer usage (dedup prevents the stale ones from
 * re-appearing).
 */
export const STALE_OPEN_PROPOSALS_MS = 7 * 24 * 60 * 60 * 1000

/** Cap the cron sweep so one tick can never fan out an unbounded scan/dispatch. */
export const MAX_ORGS_PER_GENERATION_SWEEP = 200
export const MAX_GENERATION_DISPATCHES_PER_TICK = 10

export interface ShouldGenerateArgs {
  /** Newest TemplateProposal.createdAt for the org, or null if never generated. */
  lastGeneratedAt: Date | null
  /** True when the org already has unreviewed `open` proposals. */
  hasOpenProposals: boolean
  now: Date
  /** True once the org meets the 3-integration gate. */
  meetsGate: boolean
}

/**
 * PURE debounce decision — the single source of truth for both triggers.
 * Generate only when: the gate is met, no batch is already waiting to be
 * reviewed, and nothing has been generated inside the debounce window. A batch
 * generated EXACTLY `GENERATION_DEBOUNCE_MS` ago is still too recent (strictly
 * older than the window is required).
 */
export function shouldGenerateNow({ lastGeneratedAt, hasOpenProposals, now, meetsGate }: ShouldGenerateArgs): boolean {
  if (!meetsGate) return false
  // Open-proposal guard: don't pile a second batch on an unreviewed one — UNLESS
  // that batch is stale (> STALE_OPEN_PROPOSALS_MS). Without the escape, an inbox
  // the user never clears would freeze generation forever, so newer usage never
  // surfaces. Generation-side dedup keeps the stale ones from re-appearing.
  if (hasOpenProposals && (!lastGeneratedAt || now.getTime() - lastGeneratedAt.getTime() <= STALE_OPEN_PROPOSALS_MS)) return false
  if (lastGeneratedAt && now.getTime() - lastGeneratedAt.getTime() <= GENERATION_DEBOUNCE_MS) return false
  return true
}

/** The org's most recent generation instant = its newest proposal's createdAt. */
async function readLastGeneratedAt(organizationId: string): Promise<Date | null> {
  const latest = await prisma.templateProposal.findFirst({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })
  return latest?.createdAt ?? null
}

/**
 * Enqueue a generation job for an org (mirrors dispatchFlowExecution):
 *  - inline mode → run `generateTemplateProposals` in-process and return its result.
 *  - queue mode → add to TEMPLATE_GENERATION and return `{ queued: true }`.
 * The jobId is per-org (no timestamp) so a gate-clear and a cron tick racing for
 * the same org collapse to one waiting job; `removeOnComplete: true` clears it
 * immediately so the NEXT window can re-enqueue that org.
 */
export async function dispatchTemplateGeneration(
  organizationId: string,
): Promise<GenerationResult | { queued: true }> {
  if (inlineExecution) return generateTemplateProposals(organizationId)
  if (!workersEnabled) throw new Error('Template generation worker is disabled')
  const queue = createQueue(QUEUE_NAMES.TEMPLATE_GENERATION)
  await queue.add(
    'generate-templates',
    { organizationId } satisfies TemplateGenerationJob,
    { jobId: `tmplgen-${organizationId}`, removeOnComplete: true, removeOnFail: 100, attempts: 1 },
  )
  return { queued: true }
}

/** BullMQ job handler — the worker runs the Task-2 generation core per job. */
export async function executeTemplateGenerationJob(job: Job<TemplateGenerationJob>): Promise<GenerationResult> {
  return generateTemplateProposals(job.data.organizationId)
}

/**
 * The shared per-org decision + dispatch used by BOTH triggers. Reads the gate,
 * the open-queue, and the last-generation marker (all org-scoped), applies
 * `shouldGenerateNow`, and dispatches when eligible.
 */
async function maybeGenerateForOrg(
  organizationId: string,
  now: Date,
): Promise<{ dispatched: boolean; reason: 'gate' | 'debounce' | 'dispatched' }> {
  const count = await countConnectedIntegrations(organizationId, ORG_GATE_USER_ID)
  const meetsGate = meetsTemplateGate(count)
  if (!meetsGate) return { dispatched: false, reason: 'gate' }

  const [lastGeneratedAt, open] = await Promise.all([
    readLastGeneratedAt(organizationId),
    listOpenProposals(organizationId),
  ])
  if (!shouldGenerateNow({ lastGeneratedAt, hasOpenProposals: open.length > 0, now, meetsGate })) {
    return { dispatched: false, reason: 'debounce' }
  }

  await dispatchTemplateGeneration(organizationId)
  return { dispatched: true, reason: 'dispatched' }
}

/**
 * Trigger (a): call when an org's integration gate first clears (the 3rd
 * connect). Debounced exactly like the sweep, so calling it on every connect is
 * safe — it only dispatches on the eligible transition. Best-effort by contract:
 * the caller should not let a generation hiccup fail the connect flow.
 */
export async function maybeGenerateOnGateClear(
  organizationId: string,
): Promise<{ dispatched: boolean; reason: 'gate' | 'debounce' | 'dispatched' }> {
  // The customer edition has no AI template generation. Guarded here rather
  // than at the call sites so any future caller inherits it.
  if (isCustomerEdition()) return { dispatched: false, reason: 'gate' }
  return maybeGenerateForOrg(organizationId, new Date())
}

/**
 * Trigger (b): the daily cron sweep. Enumerates orgs (the only cross-org read —
 * CRON_SECRET-gated), and dispatches a debounced generation for each eligible
 * one, capped per tick. One org's failure never aborts the sweep. Returns the
 * ids dispatched (for the cron response).
 */
export async function sweepTemplateGeneration(now: Date = new Date()): Promise<string[]> {
  // The customer edition has no AI template generation. Returning [] keeps the
  // cron response contract (`generatedOrgs`) edition-independent, so the caller
  // in cron/dispatch needs no edition awareness of its own.
  if (isCustomerEdition()) return []
  // systemPrisma: global org enumeration — the only cross-org read (CRON_SECRET-gated).
  const orgs = await systemPrisma.organization.findMany({
    select: { id: true },
    take: MAX_ORGS_PER_GENERATION_SWEEP,
  })
  const dispatched: string[] = []
  for (const org of orgs) {
    if (dispatched.length >= MAX_GENERATION_DISPATCHES_PER_TICK) break
    try {
      const result = await maybeGenerateForOrg(org.id, now)
      if (result.dispatched) dispatched.push(org.id)
    } catch (error) {
      apiLogger.error('template-generation sweep: org skipped', {
        organizationId: org.id,
        error: error instanceof Error ? error.message : String(error),
      })
      continue
    }
  }
  return dispatched
}
