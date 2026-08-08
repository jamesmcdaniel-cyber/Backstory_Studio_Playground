import { NextRequest, NextResponse } from 'next/server'
import { systemPrisma, prisma } from '@/lib/prisma'
import { rateLimit } from '@/lib/ratelimit'
import { flowInputFromWebhookBody } from '@/lib/flows/input'
import { dispatchDetachedFlowExecution } from '@/features/flows/execute-flow'
import { flowResumeTokenValid } from '@/lib/flows/resume-token'
import { readRequestTextLimited, RequestBodyTooLargeError } from '@/lib/net/request-body'

export const runtime = 'nodejs'
const MAX_RESUME_BODY_BYTES = 1_000_000

/**
 * Public callback endpoint for a `wait` step in `webhook` mode. The run exposes
 * {{run.resumeUrl}} (this URL, carrying a distinct one-time capability) to a
 * pre-wait step, which hands it to an external system (DocuSign, an approval
 * service, …). When that system POSTs back here, the run resumes with the POST
 * body as the wait step's output. No session; the run must be genuinely
 * waiting on a webhook wait and the capability hash must match.
 */
export async function POST(request: NextRequest) {
  // Path: /api/flows/[id]/runs/[runId]/resume
  const parts = request.nextUrl.pathname.split('/')
  const runId = parts.at(-2)
  const flowId = parts.at(-4)
  if (!flowId || !runId) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const limited = await rateLimit(`flow-resume:${runId}`, { limit: 30, windowMs: 60_000, failureMode: 'closed' })
  if (!limited.ok) return NextResponse.json({ success: false, error: 'Rate limit exceeded' }, { status: 429 })

  // systemPrisma: session-less callback (unguessable run id is the capability).
  const provided = request.nextUrl.searchParams.get('token') || request.headers.get('x-resume-token') || ''
  const run = await systemPrisma.flowRun.findFirst({ where: { id: runId, flowId } })
  if (!run) return NextResponse.json({ success: false, error: 'Run not found' }, { status: 404 })
  if (!run.resumeTokenHash || !flowResumeTokenValid(run.id, provided, run.resumeTokenHash)) {
    return NextResponse.json({ success: false, error: 'Invalid resume capability.' }, { status: 401 })
  }
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
  let rawBody: string
  try {
    rawBody = await readRequestTextLimited(request, MAX_RESUME_BODY_BYTES)
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ success: false, error: 'Callback body is too large.' }, { status: 413 })
    }
    throw error
  }
  let body: unknown = rawBody
  if (contentType.toLowerCase().includes('application/json')) {
    try {
      body = rawBody ? JSON.parse(rawBody) : {}
    } catch {
      return NextResponse.json({ success: false, error: 'Callback body is not valid JSON.' }, { status: 400 })
    }
  }
  const payload = flowInputFromWebhookBody(body)

  // One winner consumes the capability. A duplicate or concurrent replay sees
  // a null hash and cannot dispatch a second resume.
  const consumed = await systemPrisma.flowRun.updateMany({
    where: { id: run.id, flowId, status: 'waiting', resumeTokenHash: run.resumeTokenHash },
    data: { resumeTokenHash: null },
  })
  if (consumed.count !== 1) {
    return NextResponse.json({ success: false, error: 'This callback has already been consumed.' }, { status: 409 })
  }

  const userId =
    run.userId ??
    (await prisma.user.findFirst({ where: { organizationId: run.organizationId, isActive: true }, orderBy: { createdAt: 'asc' } }))?.id
  if (!userId) return NextResponse.json({ success: false, error: 'No active user to resume the run.' }, { status: 409 })

  // reply is a non-empty string so runFlowExecution treats this as a resume and
  // the wait step exposes the callback body as {{step.<id>.output}}.
  try {
    await dispatchDetachedFlowExecution({
      flowId,
      organizationId: run.organizationId,
      userId,
      input: {},
      flowRunId: run.id,
      reply: typeof payload === 'string' && payload ? payload : JSON.stringify(payload ?? {}),
    })
  } catch (error) {
    // A synchronous handoff failure is safely retryable with the same URL.
    await systemPrisma.flowRun.updateMany({
      where: { id: run.id, flowId, status: 'waiting', resumeTokenHash: null },
      data: { resumeTokenHash: run.resumeTokenHash },
    })
    throw error
  }

  return NextResponse.json({ success: true, runId: run.id, status: 'running' })
}
