import { NextRequest, NextResponse } from 'next/server'
import { prisma, systemPrisma } from '@/lib/prisma'
import { startFlowExecution } from '@/features/flows/execute-flow'
import { hostedFormDefinition, normalizeHostedFormSubmission } from '@/lib/flows/form'
import { triggerConditionPasses } from '@/lib/flows/trigger-condition'
import { readRequestBytesLimited, RequestBodyError, requestBodyErrorResponse } from '@/lib/server/request-body'
import { rateLimit } from '@/lib/ratelimit'
import { clientIp, recordSecurityEvent } from '@/lib/security/events'
import { recordAudit } from '@/lib/audit'
import { apiLogger } from '@/lib/logger'

const FORM_BODY_LIMIT = 128_000

export async function POST(request: NextRequest) {
  const id = request.nextUrl.pathname.split('/').at(-2) ?? ''
  const ip = clientIp(request)
  try {
    const limited = await rateLimit(`hosted-form:${id}:${ip}`, { limit: 20, windowMs: 60_000, failureMode: 'open' })
    if (!limited.ok) {
      await recordSecurityEvent({ kind: 'abuse.rate_limited', path: request.nextUrl.pathname, method: 'POST', ip, detail: { surface: 'hosted-form' } })
      return NextResponse.json({ success: false, error: 'Too many submissions. Try again shortly.' }, { status: 429 })
    }
    let bytes: Uint8Array
    try {
      bytes = await readRequestBytesLimited(request, FORM_BODY_LIMIT)
    } catch (error) {
      if (error instanceof RequestBodyError) return requestBodyErrorResponse(error)
      throw error
    }
    let body: unknown
    try { body = JSON.parse(Buffer.from(bytes).toString('utf8')) }
    catch { return NextResponse.json({ success: false, error: 'Invalid form submission.' }, { status: 400 }) }
    const envelope = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
    // Honeypot: answer success without creating a run, so bots get no feedback.
    if (typeof envelope.website === 'string' && envelope.website.trim()) return NextResponse.json({ success: true })

    // systemPrisma: session-less public form; id is globally unique and the
    // trigger/status/published checks below are the complete exposure gate.
    const flow = await systemPrisma.flow.findFirst({ where: { id } })
    const definition = flow ? hostedFormDefinition(flow.name, flow.trigger) : null
    if (!flow || !definition || flow.status !== 'ACTIVE' || !flow.publishedGraph) {
      return NextResponse.json({ success: false, error: 'This form is not available.' }, { status: 404 })
    }
    let input: Record<string, unknown>
    try { input = normalizeHostedFormSubmission(definition, envelope.values) }
    catch (error) { return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Invalid form submission.' }, { status: 400 }) }
    if (!triggerConditionPasses(flow.trigger, input)) {
      return NextResponse.json({ success: true, filtered: true })
    }
    const owner = flow.userId
      ? await prisma.user.findFirst({ where: { id: flow.userId, organizationId: flow.organizationId, isActive: true } })
      : await prisma.user.findFirst({ where: { organizationId: flow.organizationId, isActive: true }, orderBy: { createdAt: 'asc' } })
    if (!owner) return NextResponse.json({ success: false, error: 'This form is temporarily unavailable.' }, { status: 409 })
    const started = await startFlowExecution({
      flowId: flow.id,
      organizationId: flow.organizationId,
      userId: owner.id,
      input,
      usePublished: true,
      trigger: { type: 'form' },
    })
    await recordAudit({
      organizationId: flow.organizationId,
      actorKind: 'system',
      action: 'flow.form_submitted',
      resourceType: 'flow',
      resourceId: flow.id,
      executionId: started.flowRunId,
      payload: input,
      ip,
    })
    return NextResponse.json({ success: true, accepted: true, runId: started.flowRunId }, { status: 202 })
  } catch (error) {
    apiLogger.error('hosted form submission failed', { flowId: id, error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ success: false, error: 'The form could not be submitted.' }, { status: 500 })
  }
}
