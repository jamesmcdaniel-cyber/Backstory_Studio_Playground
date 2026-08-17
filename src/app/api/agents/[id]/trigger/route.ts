import { timingSafeEqual } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma, systemPrisma } from '@/lib/prisma'
import { createQueue, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { apiLogger } from '@/lib/logger'
import { runAgentExecution } from '@/features/agents/execute-agent'
import { inlineExecution } from '@/lib/queue/execution-mode'
import { hashToken, timingSafeEqualHex } from '@/lib/crypto/secrets'
import { rateLimit } from '@/lib/ratelimit'
import { recordTokenRejection } from '@/lib/security/events'

export const runtime = 'nodejs'
export const maxDuration = 1800

function legacyPlaintextMatch(provided: string, expected: string) {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

// Validate the presented secret against the stored SHA-256 hash. Falls back to
// a constant-time plaintext compare for agents whose secret predates hashing.
function triggerSecretValid(provided: string, metadata: Record<string, unknown>) {
  const hash = typeof metadata.triggerSecretHash === 'string' ? metadata.triggerSecretHash : null
  if (hash) return timingSafeEqualHex(hashToken(provided), hash)
  const legacy = typeof metadata.triggerSecret === 'string' ? metadata.triggerSecret : null
  return legacy ? legacyPlaintextMatch(provided, legacy) : false
}

// External trigger for agents (webhooks, API calls, Pipedream event sources).
// Authenticated by the per-agent secret instead of a Supabase session.
export async function POST(request: NextRequest) {
  try {
    const id = request.nextUrl.pathname.split('/').at(-2)
    // Public endpoint — throttle per agent id to blunt secret-guessing and
    // trigger floods before any DB work.
    const limited = await rateLimit(`trigger:${id ?? 'unknown'}`, { limit: 60, windowMs: 60_000, failureMode: 'closed' })
    if (!limited.ok) {
      return NextResponse.json({ success: false, error: 'Rate limit exceeded' }, { status: 429 })
    }
    const provided =
      request.headers.get('x-trigger-secret') ||
      (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
    if (!id || !provided) {
      await recordTokenRejection(request, { surface: 'agent-trigger', reason: 'missing_secret' })
      return NextResponse.json({ success: false, error: 'Missing trigger secret' }, { status: 401 })
    }

    // systemPrisma: session-less webhook trigger (per-agent secret, no org context); agent id is globally unique.
  const agent = await systemPrisma.agentTask.findFirst({ where: { id, status: 'ACTIVE' } })
    const metadata = agent?.metadata && typeof agent.metadata === 'object' ? agent.metadata as Record<string, unknown> : {}
    if (!agent || !triggerSecretValid(provided, metadata)) {
      await recordTokenRejection(request, {
        surface: 'agent-trigger',
        reason: agent ? 'invalid_secret' : 'unknown_agent',
        organizationId: agent?.organizationId ?? null,
      })
      return NextResponse.json({ success: false, error: 'Invalid trigger secret' }, { status: 401 })
    }

    const body = await request.json().catch(() => ({})) as { input?: unknown }
    // Skills are composed into the system prompt inside runAgentExecution — pass
    // the raw objective so attached skills aren't applied twice.
    const input = typeof body.input === 'string' && body.input.trim() ? body.input.trim() : agent.objective

    // Attribute the run to the agent's owner when set; otherwise fall back to
    // the org's oldest active member (shared agents have no single owner).
    const owner = agent.userId
      ? await prisma.user.findFirst({
          where: { id: agent.userId, organizationId: agent.organizationId, isActive: true },
        })
      : null
    const user =
      owner ||
      (await prisma.user.findFirst({
        where: { organizationId: agent.organizationId, isActive: true },
        orderBy: { createdAt: 'asc' },
      }))
    if (!user) {
      return NextResponse.json({ success: false, error: 'No active user in organization' }, { status: 409 })
    }

    // Idempotency: at-least-once/retrying senders (Pipedream, monitors) can
    // deliver the same event twice. When they supply a key, a duplicate returns
    // the existing execution instead of firing the agent again — reusing the
    // @@unique([organizationId, idempotencyKey]) constraint.
    const idempotencyKey = request.headers.get('x-idempotency-key')?.trim() || undefined

    let execution
    try {
      execution = await prisma.agentExecution.create({
        data: {
          agentType: agent.agentType,
          agentTaskId: agent.id,
          status: 'pending',
          input: { prompt: input },
          trigger: { type: 'webhook' },
          metadata: { title: (metadata.title as string) || agent.description },
          userId: user.id,
          organizationId: agent.organizationId,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        },
      })
    } catch (error) {
      if (idempotencyKey && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await prisma.agentExecution.findFirst({
          where: { organizationId: agent.organizationId, idempotencyKey },
        })
        if (existing) {
          return NextResponse.json({ success: true, executionId: existing.id, status: existing.status, duplicate: true })
        }
      }
      throw error
    }

    if (inlineExecution) {
      try {
        const result = await runAgentExecution({
          executionId: execution.id,
          agentId: agent.id,
          organizationId: agent.organizationId,
          userId: user.id,
          input,
        })
        return NextResponse.json({ success: true, executionId: execution.id, result })
      } catch (error) {
        // systemPrisma: session-less trigger path; execution id was minted org-scoped above.
        await systemPrisma.agentExecution.update({
          where: { id: execution.id },
          data: {
            status: 'failed',
            // M5 — cap persisted error strings so they can't bloat the row.
            error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
            completedAt: new Date(),
          },
        })
        return NextResponse.json({ success: false, error: 'Agent run failed' }, { status: 500 })
      }
    } else {
      if (!workersEnabled) {
        return NextResponse.json({ success: false, error: 'Agent worker is disabled' }, { status: 503 })
      }
      const queue = createQueue(QUEUE_NAMES.AGENT_EXECUTION)
      await queue.add('execute-agent', {
        executionId: execution.id,
        agentId: agent.id,
        organizationId: agent.organizationId,
        userId: user.id,
        input,
      }, { jobId: execution.id })

      return NextResponse.json({ success: true, executionId: execution.id, status: 'pending' })
    }
  } catch (error) {
    apiLogger.error('Agent trigger failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
