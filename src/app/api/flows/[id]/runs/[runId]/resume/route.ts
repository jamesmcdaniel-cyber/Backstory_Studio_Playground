import { NextRequest, NextResponse } from 'next/server'
import { systemPrisma, prisma } from '@/lib/prisma'
import { rateLimit } from '@/lib/ratelimit'
import { flowInputFromWebhookBody } from '@/lib/flows/input'
import { dispatchDetachedFlowExecution } from '@/features/flows/execute-flow'

export const runtime = 'nodejs'

/**
 * Public callback endpoint for a `wait` step in `webhook` mode. The run exposes
 * {{run.resumeUrl}} (this URL, carrying the run's unguessable cuid) to a
 * pre-wait step, which hands it to an external system (DocuSign, an approval
 * service, …). When that system POSTs back here, the run resumes with the POST
 * body as the wait step's output. No session — the unguessable run id is the
 * capability, and the run must be genuinely waiting on a webhook wait.
 */
export async function POST(request: NextRequest) {
  // Path: /api/flows/[id]/runs/[runId]/resume
  const parts = request.nextUrl.pathname.split('/')
  const runId = parts.at(-2)
  const flowId = parts.at(-4)
  if (!flowId || !runId) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const limited = await rateLimit(`flow-resume:${runId}`, { limit: 60, windowMs: 60_000 })
  if (!limited.ok) return NextResponse.json({ success: false, error: 'Rate limit exceeded' }, { status: 429 })

  // systemPrisma: session-less callback (unguessable run id is the capability).
  const run = await systemPrisma.flowRun.findFirst({ where: { id: runId, flowId } })
  if (!run) return NextResponse.json({ success: false, error: 'Run not found' }, { status: 404 })
  if (run.status !== 'waiting') {
    return NextResponse.json({ success: false, error: 'This run is not waiting for a callback.' }, { status: 409 })
  }

  // The run must be paused on a webhook wait — never resume an approval/human
  // pause (which has its own routes) through this public endpoint.
  const waitingSteps = await systemPrisma.flowRunStep.findMany({
    where: { flowRunId: run.id, status: 'waiting' },
    select: { output: true },
  })
  const onWebhookWait = waitingSteps.some(
    (step) => (step.output as { waiting?: { kind?: string } } | null)?.waiting?.kind === 'webhook',
  )
  if (!onWebhookWait) {
    return NextResponse.json({ success: false, error: 'This run is not waiting on a webhook callback.' }, { status: 409 })
  }

  const contentType = request.headers.get('content-type') || ''
  const body = contentType.toLowerCase().includes('application/json')
    ? await request.json().catch(() => ({}))
    : await request.text().catch(() => '')
  const payload = flowInputFromWebhookBody(body)

  const userId =
    run.userId ??
    (await prisma.user.findFirst({ where: { organizationId: run.organizationId, isActive: true }, orderBy: { createdAt: 'asc' } }))?.id
  if (!userId) return NextResponse.json({ success: false, error: 'No active user to resume the run.' }, { status: 409 })

  // reply is a non-empty string so runFlowExecution treats this as a resume and
  // the wait step exposes the callback body as {{step.<id>.output}}.
  await dispatchDetachedFlowExecution({
    flowId,
    organizationId: run.organizationId,
    userId,
    input: {},
    flowRunId: run.id,
    reply: typeof payload === 'string' && payload ? payload : JSON.stringify(payload ?? {}),
  })

  return NextResponse.json({ success: true, runId: run.id, status: 'running' })
}
