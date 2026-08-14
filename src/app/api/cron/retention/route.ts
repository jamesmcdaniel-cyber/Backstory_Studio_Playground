/**
 * /api/cron/retention — daily pruning of unbounded-growth tables.
 *
 * Deletes terminal executions, signals, flow runs, files, webhook receipts,
 * and settled outbox events after their configured retention windows.
 * Deleting an execution cascades its workflow steps/events/messages. Audit
 * events are intentionally NOT pruned (append-only for compliance). Capped per
 * run so a backlog is worked down over successive days rather than in one huge
 * transaction.
 *
 * Auth (fail closed): requires Authorization: Bearer <CRON_SECRET>.
 */

import { timingSafeEqual } from 'crypto'
import { Prisma } from '@prisma/client'
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { removeRetiredFromGraph } from '@/lib/rag/indexer'
import { deleteStoredFile } from '@/lib/files/storage'
import { recordTokenRejection } from '@/lib/security/events'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

const CAP = 5000

async function checkAuthorized(request: Request): Promise<Response | null> {
  const secret = process.env.CRON_SECRET
  if (!secret) return Response.json({ success: false, error: 'CRON_SECRET not configured' }, { status: 503 })
  const authHeader = request.headers.get('authorization') || ''
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  if (!(a.length === b.length && timingSafeEqual(a, b))) {
    await recordTokenRejection(request, { surface: 'cron', reason: 'invalid_cron_secret' })
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

export async function GET(request: Request) {
  const unauthorized = await checkAuthorized(request)
  if (unauthorized) return unauthorized

  const days = Number(process.env.RETENTION_DAYS) || 90
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  try {
    // systemPrisma: global retention sweep — prunes across all orgs by design (CRON_SECRET-gated).
    const staleExecutions = await systemPrisma.agentExecution.findMany({
      where: { startedAt: { lt: cutoff } }, select: { id: true, organizationId: true }, take: CAP,
    })
    // systemPrisma: global retention sweep — prunes across all orgs by design (CRON_SECRET-gated).
    const staleSignals = await systemPrisma.signal.findMany({
      where: { receivedAt: { lt: cutoff } }, select: { id: true, organizationId: true }, take: CAP,
    })
    // systemPrisma: global retention sweep — terminal flow runs contain the
    // same sensitive inputs/outputs as agent executions and must not outlive
    // the configured retention window.
    const staleFlowRuns = await systemPrisma.flowRun.findMany({
      where: { startedAt: { lt: cutoff }, status: { in: ['succeeded', 'failed', 'cancelled'] } },
      select: { id: true },
      take: CAP,
    })

    // Graph parity: prune the run:/signal: nodes for the rows this sweep is
    // about to delete — graph-first, because after the Postgres delete the
    // ids are gone and a missed node would linger forever (audit: deleted
    // PII resurfacing in RAG context).
    const graphGroups = new Map<string, { organizationId: string; executionIds: string[]; signalIds: string[] }>()
    for (const e of staleExecutions) {
      const group = graphGroups.get(e.organizationId) ?? { organizationId: e.organizationId, executionIds: [], signalIds: [] }
      group.executionIds.push(e.id)
      graphGroups.set(e.organizationId, group)
    }
    for (const s of staleSignals) {
      const group = graphGroups.get(s.organizationId) ?? { organizationId: s.organizationId, executionIds: [], signalIds: [] }
      group.signalIds.push(s.id)
      graphGroups.set(s.organizationId, group)
    }
    try {
      await removeRetiredFromGraph(Array.from(graphGroups.values()))
    } catch (error) {
      apiLogger.error('cron/retention: graph cleanup failed', { error: error instanceof Error ? error.message : String(error) })
    }

    // systemPrisma: global retention sweep — prunes across all orgs by design (CRON_SECRET-gated).
    const executionsDeleted = staleExecutions.length
      ? (await systemPrisma.agentExecution.deleteMany({ where: { id: { in: staleExecutions.map((e) => e.id) } } })).count
      : 0

    // systemPrisma: global retention sweep — prunes across all orgs by design (CRON_SECRET-gated).
    const signalsDeleted = staleSignals.length
      ? (await systemPrisma.signal.deleteMany({ where: { id: { in: staleSignals.map((s) => s.id) } } })).count
      : 0
    // systemPrisma: global retention sweep — ids were selected by age/status above.
    const flowRunsDeleted = staleFlowRuns.length
      ? (await systemPrisma.flowRun.deleteMany({ where: { id: { in: staleFlowRuns.map((run) => run.id) } } })).count
      : 0

    // Public webhook replay receipts only need to cover the retry window.
    // systemPrisma: global expiry sweep by an intrinsic timestamp.
    const webhookReceiptsPruned = (await systemPrisma.flowWebhookReceipt.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    })).count
    // Delivered/dead-letter outbox rows are operational history, not permanent
    // audit records. Pending/processing rows are never removed by retention.
    const outboxEventsPruned = (await systemPrisma.outboxEvent.deleteMany({
      where: { createdAt: { lt: cutoff }, status: { in: ['delivered', 'failed'] } },
    })).count

    // Original uploaded bytes have their own retention window. Delete through
    // the storage abstraction so Supabase objects and database rows stay in sync.
    const fileDays = Number(process.env.FILE_RETENTION_DAYS) || days
    // systemPrisma: global retention read; each deletion below is re-scoped to its org.
    const staleFiles = await systemPrisma.storedFile.findMany({
      where: { createdAt: { lt: new Date(Date.now() - fileDays * 24 * 60 * 60 * 1000) } },
      select: { id: true, organizationId: true },
      take: Math.min(CAP, 500),
    })
    const fileResults = await Promise.allSettled(staleFiles.map((file) => deleteStoredFile(file.id, file.organizationId)))
    const storedFilesPruned = fileResults.filter((result) => result.status === 'fulfilled' && result.value).length
    const storedFileDeleteFailures = fileResults.filter((result) => result.status === 'rejected').length
    if (storedFileDeleteFailures) {
      apiLogger.warn('cron/retention: some stored files could not be removed', { failed: storedFileDeleteFailures })
    }

    // Transcripts are the fattest column (provider message JSON, growing per
    // turn — can reach MBs per run). They only matter for RESUMING a run, so
    // terminal runs older than TRANSCRIPT_RETENTION_DAYS (default 14) have
    // theirs nulled long before the row itself is deleted at RETENTION_DAYS.
    const transcriptDays = Number(process.env.TRANSCRIPT_RETENTION_DAYS) || 14
    const transcriptCutoff = new Date(Date.now() - transcriptDays * 24 * 60 * 60 * 1000)
    // systemPrisma: global retention sweep — prunes across all orgs by design (CRON_SECRET-gated).
    const staleTranscripts = await systemPrisma.agentExecution.findMany({
      where: {
        completedAt: { lt: transcriptCutoff },
        status: { in: ['completed', 'failed'] },
        NOT: { transcript: { equals: Prisma.DbNull } },
      },
      select: { id: true },
      take: CAP,
    })
    // systemPrisma: global retention sweep — prunes across all orgs by design (CRON_SECRET-gated).
    const transcriptsPruned = staleTranscripts.length
      ? (await systemPrisma.agentExecution.updateMany({
          where: { id: { in: staleTranscripts.map((e) => e.id) } },
          data: { transcript: Prisma.DbNull },
        })).count
      : 0

    // Huddle segments are transient working state deleted at summary time; any
    // still here after 24h belong to a session nobody summarised (laptop shut
    // mid-huddle). Sweeping them is what keeps the "raw speech never lingers"
    // retention promise honest.
    // systemPrisma: global retention sweep — prunes across all orgs by design (CRON_SECRET-gated).
    const huddleSegmentsPruned = (await systemPrisma.huddleSegment.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    })).count

    // Side-effect ledger rows outlive their run ON PURPOSE (flowRunId is
    // nullable with ON DELETE SET NULL, so poll-scoped rows keep working after
    // the run is gone) — which means run retention never reaches them and they
    // would otherwise grow without bound. Swept on their own age instead.
    //
    // The horizon must EXCEED the longest poll cadence, or the duplicate window
    // reopens: a re-emitted item whose ledger row was already swept fires its
    // writes again. 30 days is far beyond any cadence the picker offers
    // (every15min through days-of-week), with room to spare.
    // systemPrisma: global retention sweep — prunes across all orgs by design (CRON_SECRET-gated).
    const ledgerDays = Number(process.env.SIDE_EFFECT_RETENTION_DAYS) || 30
    const sideEffectsPruned = (await systemPrisma.flowSideEffect.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - ledgerDays * 24 * 60 * 60 * 1000) } },
    })).count

    // LlmCall detail ages out at 90 days. The denormalized costUsd totals on
    // AgentExecution/FlowRun survive, so historical run cost stays visible
    // after the per-call breakdown is gone.
    // systemPrisma: global retention sweep — prunes across all orgs by design (CRON_SECRET-gated).
    const llmCallsPruned = (await systemPrisma.llmCall.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } },
    })).count

    apiLogger.info('cron/retention complete', { days, executionsDeleted, flowRunsDeleted, signalsDeleted, transcriptsPruned, webhookReceiptsPruned, outboxEventsPruned, storedFilesPruned, storedFileDeleteFailures, huddleSegmentsPruned, llmCallsPruned, sideEffectsPruned })
    return Response.json({ success: true, days, executionsDeleted, flowRunsDeleted, signalsDeleted, transcriptsPruned, webhookReceiptsPruned, outboxEventsPruned, storedFilesPruned, storedFileDeleteFailures, huddleSegmentsPruned, llmCallsPruned, sideEffectsPruned })
  } catch (error) {
    apiLogger.error('cron/retention failed', { error: error instanceof Error ? error.message : String(error) })
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
