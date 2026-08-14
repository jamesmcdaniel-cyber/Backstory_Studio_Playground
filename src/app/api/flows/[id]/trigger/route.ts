import { NextRequest, NextResponse } from 'next/server'
import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { runFlowExecution, startFlowExecution } from '@/features/flows/execute-flow'
import { hashToken, timingSafeEqualHex } from '@/lib/crypto/secrets'
import { rateLimit } from '@/lib/ratelimit'
import { recordTokenRejection } from '@/lib/security/events'
import { flowInputFromWebhookBody } from '@/lib/flows/input'
import { ApiError } from '@/lib/server/api-handler'
import { triggerConditionPasses } from '@/lib/flows/trigger-condition'
import { Prisma } from '@prisma/client'
import {
  FLOW_WEBHOOK_MAX_BODY_BYTES,
  parseWebhookBody,
  WebhookBodyError,
  parseWebhookReplayHeaders,
  webhookPayloadHash,
} from '@/lib/flows/webhook-security'

export const runtime = 'nodejs'
export const maxDuration = 800

// External webhook trigger for flows. Authenticated by the per-flow secret
// (hash stored in flow.trigger.webhookSecretHash) instead of a session — mirrors
// the agent trigger endpoint. Runs the PUBLISHED graph.
export async function POST(request: NextRequest) {
  try {
    const id = request.nextUrl.pathname.split('/').at(-2)
    // Public endpoint — throttle per flow id to blunt secret-guessing floods.
    // Fails OPEN on a limiter-backend outage: with Redis down, fail-closed
    // 429'd every webhook and events were lost. The secret is 24 random bytes
    // (brute-force infeasible even unthrottled) and delivery matters more
    // than throttling during an outage.
    const limited = await rateLimit(`flow-trigger:${id ?? 'unknown'}`, { limit: 60, windowMs: 60_000, failureMode: 'open' })
    if (!limited.ok) return NextResponse.json({ success: false, error: 'Rate limit exceeded' }, { status: 429 })

    const provided =
      request.headers.get('x-trigger-secret') ||
      (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
    if (!id || !provided) {
      await recordTokenRejection(request, { surface: 'flow-trigger', reason: 'missing_secret' })
      return NextResponse.json({ success: false, error: 'Missing trigger secret' }, { status: 401 })
    }

    // systemPrisma: session-less webhook trigger (per-flow secret, no org context); flow id is globally unique.
    // Looked up WITHOUT a status filter: the secret is verified first, and only
    // a caller holding the valid secret learns the flow's arming state. An
    // unarmed flow used to 401 "Invalid trigger secret", which sent people off
    // rotating credentials when the actual fix was "publish the flow".
    const flow = await systemPrisma.flow.findFirst({ where: { id } })
    const trigger = (flow?.trigger && typeof flow.trigger === 'object' && !Array.isArray(flow.trigger) ? flow.trigger : {}) as Record<string, unknown>
    const hash = typeof trigger.webhookSecretHash === 'string' ? trigger.webhookSecretHash : null
    if (!flow || !hash || !timingSafeEqualHex(hashToken(provided), hash)) {
      await recordTokenRejection(request, {
        surface: 'flow-trigger',
        reason: !flow ? 'unknown_flow' : !hash ? 'no_secret_configured' : 'invalid_secret',
        organizationId: flow?.organizationId ?? null,
      })
      return NextResponse.json({ success: false, error: 'Invalid trigger secret' }, { status: 401 })
    }
    if (trigger.type !== 'webhook') {
      return NextResponse.json({ success: false, error: 'This flow is not configured for webhook triggering.' }, { status: 409 })
    }
    if (flow.status !== 'ACTIVE' || flow.publishedGraph == null) {
      return NextResponse.json(
        { success: false, error: 'The webhook secret is valid but the flow is not armed — publish the flow to start receiving events.' },
        { status: 409 },
      )
    }

    // The run is attributed to the flow's owner (or the org's oldest member).
    const owner = flow.userId
      ? await prisma.user.findFirst({ where: { id: flow.userId, organizationId: flow.organizationId, isActive: true } })
      : await prisma.user.findFirst({ where: { organizationId: flow.organizationId, isActive: true }, orderBy: { createdAt: 'asc' } })
    if (!owner) return NextResponse.json({ success: false, error: 'No active user to attribute the run to' }, { status: 409 })

    const declaredLength = Number(request.headers.get('content-length') || 0)
    if (declaredLength > FLOW_WEBHOOK_MAX_BODY_BYTES) {
      return NextResponse.json({ success: false, error: 'Webhook body is too large.' }, { status: 413 })
    }
    const bytes = Buffer.from(await request.arrayBuffer())
    if (bytes.length > FLOW_WEBHOOK_MAX_BODY_BYTES) {
      return NextResponse.json({ success: false, error: 'Webhook body is too large.' }, { status: 413 })
    }
    const replay = parseWebhookReplayHeaders(request.headers)
    if (replay.error) return NextResponse.json({ success: false, error: replay.error }, { status: 400 })
    let body: unknown
    try {
      body = parseWebhookBody(bytes, request.headers.get('content-type') || '')
    } catch (error) {
      // Only messages parseWebhookBody wrote deliberately are echoed. This
      // endpoint is unauthenticated, so anything else — a decoder fault, a
      // Prisma error — would be internal detail handed to an anonymous caller.
      if (!(error instanceof WebhookBodyError)) {
        apiLogger.error('flow webhook body parse failed', {
          flowId: flow.id,
          organizationId: flow.organizationId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      const message = error instanceof WebhookBodyError ? error.message : 'Invalid webhook body.'
      return NextResponse.json({ success: false, error: message }, { status: 400 })
    }
    const input = flowInputFromWebhookBody(body)
    if (!triggerConditionPasses(trigger, input)) {
      // No run row is created for a filtered delivery, so this log line is the
      // ONLY record the event arrived — without it "my webhook missed the
      // event" and "the condition filtered it" are indistinguishable.
      apiLogger.info('flow webhook delivery filtered by trigger condition', { flowId: flow.id, organizationId: flow.organizationId })
      return NextResponse.json({ success: true, filtered: true, message: 'Trigger condition not met — run skipped.' })
    }
    let receiptId: string | undefined
    if (replay.value) {
      try {
        const receipt = await prisma.flowWebhookReceipt.create({
          data: {
            flowId: flow.id,
            organizationId: flow.organizationId,
            deliveryId: replay.value.deliveryId,
            payloadHash: webhookPayloadHash(bytes),
            expiresAt: new Date(replay.value.timestampMs + 24 * 60 * 60 * 1000),
          },
          select: { id: true },
        })
        receiptId = receipt.id
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const existing = await prisma.flowWebhookReceipt.findFirst({
            where: { flowId: flow.id, deliveryId: replay.value.deliveryId, organizationId: flow.organizationId },
            select: { id: true, payloadHash: true, flowRunId: true, status: true },
          })
          if (existing?.payloadHash !== webhookPayloadHash(bytes)) {
            return NextResponse.json({ success: false, error: 'Webhook delivery id was reused with a different payload.' }, { status: 409 })
          }
          // A failed handoff can be retried only with identical bytes. The
          // compare-and-set gives simultaneous retries a single winner.
          if (existing?.status === 'failed') {
            const reclaimed = await prisma.flowWebhookReceipt.updateMany({
              where: { id: existing.id, organizationId: flow.organizationId, status: 'failed' },
              data: { status: 'processing', lastError: null, receivedAt: new Date() },
            })
            if (reclaimed.count === 1) receiptId = existing.id
            else return NextResponse.json({ success: true, duplicate: true, flowRunId: existing.flowRunId })
          } else {
            return NextResponse.json({ success: true, duplicate: true, flowRunId: existing?.flowRunId ?? null })
          }
        }
        throw error
      }
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
      let started
      try {
        started = await startFlowExecution(job)
      } catch (error) {
        if (receiptId) await prisma.flowWebhookReceipt.updateMany({
          where: { id: receiptId, organizationId: flow.organizationId },
          data: { status: 'failed', lastError: (error instanceof Error ? error.message : 'Flow handoff failed').slice(0, 300) },
        })
        throw error
      }
      if (receiptId) {
        await prisma.flowWebhookReceipt.update({ where: { id: receiptId, organizationId: flow.organizationId }, data: { flowRunId: started.flowRunId, status: 'accepted', lastError: null } })
      }
      return NextResponse.json({ success: true, accepted: true, run: started }, { status: 202 })
    }
    let run
    try {
      run = await runFlowExecution(job)
    } catch (error) {
      if (receiptId) await prisma.flowWebhookReceipt.updateMany({
        where: { id: receiptId, organizationId: flow.organizationId },
        data: { status: 'failed', lastError: (error instanceof Error ? error.message : 'Flow execution failed').slice(0, 300) },
      })
      throw error
    }
    if (receiptId) {
      await prisma.flowWebhookReceipt.update({ where: { id: receiptId, organizationId: flow.organizationId }, data: { flowRunId: run.flowRunId, status: 'accepted', lastError: null } })
    }
    return NextResponse.json({ success: true, run })
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status })
    }
    apiLogger.error('flow trigger failed', { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
