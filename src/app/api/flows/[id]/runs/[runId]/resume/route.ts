import { NextRequest, NextResponse } from 'next/server'
import { systemPrisma, prisma, tenantTransaction } from '@/lib/prisma'
import { rateLimit } from '@/lib/ratelimit'
import { hashToken, timingSafeEqualHex } from '@/lib/crypto/secrets'
import { flowInputFromWebhookBody } from '@/lib/flows/input'
import { flowResumeOutboxEvent } from '@/lib/outbox'
import { readRequestJsonLimited, readRequestTextLimited, RequestBodyError, requestBodyErrorResponse } from '@/lib/server/request-body'
import { FLOW_WEBHOOK_MAX_BODY_BYTES } from '@/lib/flows/webhook-security'

export const runtime = 'nodejs'

/**
 * Public callback endpoint for a `wait` step in `webhook` mode. The run exposes
 * {{run.resumeUrl}} to a pre-wait step, which hands it to an external system
 * (DocuSign, an approval service, …). When that system POSTs back here, the run
 * resumes with the POST body as the wait step's output.
 *
 * The CAPABILITY IS THE TOKEN in that URL, never the run id. A run id is a
 * database identifier: members who can read the run see it, it lands in logs,
 * and it is embedded in URLs sent to third parties — so treating it as a
 * credential let anyone who ever saw one drive another workspace's flow with
 * attacker-chosen data. Only the token's SHA-256 lives in the row, minted per
 * execution attempt by execute-flow.ts, and it is compared in constant time.
 *
 * Fails CLOSED when a run carries no hash: a run that was already waiting when
 * this shipped cannot be resumed and must be re-run. Grandfathering those would
 * keep the id-as-capability hole open for exactly the runs whose ids have been
 * in circulation longest.
 */
export async function POST(request: NextRequest) {
  // Path: /api/flows/[id]/runs/[runId]/resume
  const parts = request.nextUrl.pathname.split('/')
  const runId = parts.at(-2)
  const flowId = parts.at(-4)
  if (!flowId || !runId) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  // Keyed on the CALLER, not on the run id being presented: keying by runId
  // capped attempts per candidate id and so bounded nothing across ids. Fails
  // closed — an unauthenticated ingress must not lose its ceiling when Redis is
  // unavailable.
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  const limited = await rateLimit(`flow-resume:${ip}`, { limit: 60, windowMs: 60_000, failureMode: 'closed' })
  if (!limited.ok) return NextResponse.json({ success: false, error: 'Rate limit exceeded' }, { status: 429 })

  const presented =
    request.nextUrl.searchParams.get('token')?.trim() || request.headers.get('x-resume-token')?.trim() || ''
  if (!presented) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  // systemPrisma: session-less callback; the resume token is the capability.
  const run = await systemPrisma.flowRun.findFirst({ where: { id: runId, flowId } })
  // One indistinguishable 404 for "no such run", "no token minted", and "wrong
  // token" — anything else would confirm which run ids exist.
  if (!run?.resumeTokenHash || !timingSafeEqualHex(hashToken(presented), run.resumeTokenHash)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const resumeTokenHash = run.resumeTokenHash
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
  let body: unknown
  try {
    body = contentType.toLowerCase().includes('application/json')
      ? await readRequestJsonLimited(request, FLOW_WEBHOOK_MAX_BODY_BYTES)
      : await readRequestTextLimited(request, FLOW_WEBHOOK_MAX_BODY_BYTES)
  } catch (error) {
    if (error instanceof RequestBodyError) return requestBodyErrorResponse(error)
    throw error
  }
  const payload = flowInputFromWebhookBody(body)

  const userId =
    run.userId ??
    (await prisma.user.findFirst({ where: { organizationId: run.organizationId, isActive: true }, orderBy: { createdAt: 'asc' } }))?.id
  if (!userId) return NextResponse.json({ success: false, error: 'No active user to resume the run.' }, { status: 409 })

  const reply = typeof payload === 'string' && payload ? payload : JSON.stringify(payload ?? {})
  // Consume the capability and persist its encrypted delivery in one commit.
  // The outbox retries independently of this request, so a worker/Redis outage
  // can delay the resume but cannot burn the caller's only token and lose it.
  const accepted = await tenantTransaction(run.organizationId, async (tx) => {
    const consumed = await tx.flowRun.updateMany({
      where: { id: run.id, organizationId: run.organizationId, status: 'waiting', resumeTokenHash },
      data: { resumeTokenHash: null },
    })
    if (consumed.count !== 1) return false
    await tx.outboxEvent.create({
      data: flowResumeOutboxEvent({
        organizationId: run.organizationId,
        flowId,
        flowRunId: run.id,
        userId,
        resumeTokenHash,
        reply,
      }),
    })
    return true
  })
  if (!accepted) {
    return NextResponse.json({ success: false, error: 'This callback was already delivered.' }, { status: 409 })
  }

  return NextResponse.json({ success: true, accepted: true, runId: run.id, status: 'waiting' }, { status: 202 })
}
