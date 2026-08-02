/**
 * /api/cron/retention — daily pruning of unbounded-growth tables.
 *
 * Deletes agent executions and signals older than RETENTION_DAYS (default 90).
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

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

const CAP = 5000

function checkAuthorized(request: Request): Response | null {
  const secret = process.env.CRON_SECRET
  if (!secret) return Response.json({ success: false, error: 'CRON_SECRET not configured' }, { status: 503 })
  const authHeader = request.headers.get('authorization') || ''
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  if (!(a.length === b.length && timingSafeEqual(a, b))) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

export async function GET(request: Request) {
  const unauthorized = checkAuthorized(request)
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

    apiLogger.info('cron/retention complete', { days, executionsDeleted, signalsDeleted, transcriptsPruned, huddleSegmentsPruned })
    return Response.json({ success: true, days, executionsDeleted, signalsDeleted, transcriptsPruned, huddleSegmentsPruned })
  } catch (error) {
    apiLogger.error('cron/retention failed', { error: error instanceof Error ? error.message : String(error) })
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
