import { NextRequest, NextResponse } from 'next/server'
import { systemPrisma } from '@/lib/prisma'
import { hashToken, timingSafeEqualHex } from '@/lib/crypto/secrets'
import { rateLimit } from '@/lib/ratelimit'
import { clientIp, recordTokenRejection } from '@/lib/security/events'
import { isTerminalFlowRunStatus } from '@/lib/flows/webhook-result'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const parts = request.nextUrl.pathname.split('/')
  const runId = parts.at(-2)
  const flowId = parts.at(-4)
  const limited = await rateLimit(`flow-webhook-result:${clientIp(request)}`, {
    limit: 120,
    windowMs: 60_000,
    failureMode: 'closed',
  })
  if (!limited.ok) return NextResponse.json({ success: false, error: 'Rate limit exceeded' }, { status: 429 })

  const provided =
    request.headers.get('x-trigger-secret') ||
    (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (!flowId || !runId || !provided) {
    await recordTokenRejection(request, { surface: 'flow-webhook-result', reason: 'missing_secret' })
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  // systemPrisma: session-less status lookup; the flow webhook secret is the
  // capability and the run is constrained to that exact flow below.
  const flow = await systemPrisma.flow.findUnique({ where: { id: flowId }, select: { organizationId: true, trigger: true } })
  const trigger = flow?.trigger && typeof flow.trigger === 'object' && !Array.isArray(flow.trigger)
    ? flow.trigger as Record<string, unknown>
    : {}
  const expected = typeof trigger.webhookSecretHash === 'string' ? trigger.webhookSecretHash : ''
  if (!flow || !expected || !timingSafeEqualHex(hashToken(provided), expected)) {
    await recordTokenRejection(request, {
      surface: 'flow-webhook-result',
      reason: flow ? 'invalid_secret' : 'unknown_flow',
      organizationId: flow?.organizationId ?? null,
    })
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const run = await systemPrisma.flowRun.findFirst({
    where: { id: runId, flowId, organizationId: flow.organizationId },
    select: { id: true, status: true, output: true, error: true, startedAt: true, finishedAt: true },
  })
  if (!run) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const terminal = isTerminalFlowRunStatus(run.status)
  return NextResponse.json(
    { success: terminal ? run.status === 'succeeded' : true, run: { flowRunId: run.id, ...run } },
    {
      status: terminal ? 200 : 202,
      headers: { 'cache-control': 'no-store', ...(terminal ? {} : { 'retry-after': '1' }) },
    },
  )
}
