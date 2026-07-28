import { NextRequest, NextResponse } from 'next/server'
import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { runFlowExecution, startFlowExecution } from '@/features/flows/execute-flow'
import { hashToken, timingSafeEqualHex } from '@/lib/crypto/secrets'
import { rateLimit } from '@/lib/ratelimit'
import { flowInputFromWebhookBody } from '@/lib/flows/input'
import { ApiError } from '@/lib/server/api-handler'
import { triggerConditionPasses } from '@/lib/flows/trigger-condition'

export const runtime = 'nodejs'
export const maxDuration = 800

// External webhook trigger for flows. Authenticated by the per-flow secret
// (hash stored in flow.trigger.webhookSecretHash) instead of a session — mirrors
// the agent trigger endpoint. Runs the PUBLISHED graph.
export async function POST(request: NextRequest) {
  try {
    const id = request.nextUrl.pathname.split('/').at(-2)
    // Public endpoint — throttle per flow id to blunt secret-guessing floods.
    const limited = await rateLimit(`flow-trigger:${id ?? 'unknown'}`, { limit: 60, windowMs: 60_000 })
    if (!limited.ok) return NextResponse.json({ success: false, error: 'Rate limit exceeded' }, { status: 429 })

    const provided =
      request.headers.get('x-trigger-secret') ||
      (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
    if (!id || !provided) return NextResponse.json({ success: false, error: 'Missing trigger secret' }, { status: 401 })

    // systemPrisma: session-less webhook trigger (per-flow secret, no org context); flow id is globally unique.
  const flow = await systemPrisma.flow.findFirst({ where: { id, status: 'ACTIVE' } })
    const trigger = (flow?.trigger && typeof flow.trigger === 'object' && !Array.isArray(flow.trigger) ? flow.trigger : {}) as Record<string, unknown>
    const hash = typeof trigger.webhookSecretHash === 'string' ? trigger.webhookSecretHash : null
    if (!flow || !hash || !timingSafeEqualHex(hashToken(provided), hash)) {
      return NextResponse.json({ success: false, error: 'Invalid trigger secret' }, { status: 401 })
    }
    if (trigger.type !== 'webhook') {
      return NextResponse.json({ success: false, error: 'This flow is not configured for webhook triggering.' }, { status: 409 })
    }
    if (flow.publishedGraph == null) {
      return NextResponse.json({ success: false, error: 'Publish the flow before triggering it externally.' }, { status: 409 })
    }

    // The run is attributed to the flow's owner (or the org's oldest member).
    const owner = flow.userId
      ? await prisma.user.findFirst({ where: { id: flow.userId, organizationId: flow.organizationId, isActive: true } })
      : await prisma.user.findFirst({ where: { organizationId: flow.organizationId, isActive: true }, orderBy: { createdAt: 'asc' } })
    if (!owner) return NextResponse.json({ success: false, error: 'No active user to attribute the run to' }, { status: 409 })

    const contentType = request.headers.get('content-type') || ''
    const body = contentType.toLowerCase().includes('application/json')
      ? await request.json().catch(() => ({}))
      : await request.text().catch(() => '')
    const input = flowInputFromWebhookBody(body)
    if (!triggerConditionPasses(trigger, input)) {
      return NextResponse.json({ success: true, filtered: true, message: 'Trigger condition not met — run skipped.' })
    }
    const job = {
      flowId: flow.id,
      organizationId: flow.organizationId,
      userId: owner.id,
      input,
      usePublished: true,
      trigger: { type: 'webhook' as const },
    }
    // Response mode (n8n parity). The default holds the request open until the
    // run finishes and answers with its result, which is what callers that read
    // the response expect. 'immediately' acknowledges and lets the run continue
    // in the background — for senders that time out, or fire-and-forget hooks.
    if (trigger.responseMode === 'immediately') {
      const started = await startFlowExecution(job)
      return NextResponse.json({ success: true, accepted: true, run: started }, { status: 202 })
    }
    const run = await runFlowExecution(job)
    return NextResponse.json({ success: true, run })
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status })
    }
    apiLogger.error('flow trigger failed', { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
