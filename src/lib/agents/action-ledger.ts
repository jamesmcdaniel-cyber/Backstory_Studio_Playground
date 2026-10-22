/**
 * The action ledger — "what this agent did".
 *
 * One AgentAction row per side-effecting tool call, written at the choke points
 * where writes EXECUTE and nowhere else:
 *
 *   - the agent tool loop (execute-agent.ts), for every call its binding
 *     classifies as a write — warehouse DML included, since warehouse tools are
 *     classified per call there;
 *   - flow tool steps (run-action-step.ts), likewise;
 *   - approved writes (decideApproval in ./approval.ts), which execute outside
 *     both loops — Nango, MCP "Needs approval" tools and warehouse writes alike.
 *
 * Each site wraps its one execute call in `withActionLedger`, so a write can't
 * run without a row and a row can't claim a write that didn't run. Reads pass
 * straight through.
 *
 * What a row holds, and why it is not the audit log: audit_events proves a
 * write happened (args hashed by design) but cannot say what it was or reverse
 * it. Here: a redacted, size-bounded summary of the arguments; the provider's
 * own reference to what was created (compensators.ts `ref`); for updates whose
 * provider can be read cheaply, the prior values Undo restores; and the
 * connection the call went out on (ids only) so Undo can go back through
 * exactly that one.
 *
 * Writing a row must never break the action it records: failures are logged
 * and swallowed, the same contract as recordAudit.
 */

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { redactLogMeta } from '@/lib/logging/redact'
import { describeUpstreamFailure } from '@/lib/upstream-error'
import { compensationFor, type ResultRef } from '@/lib/nango/compensators'
import { defaultProxy, type NangoProxy } from '@/lib/nango/delivery'
import type { PlaneCredential } from '@/features/agents/tool-planes'

export type ActionSource =
  | { kind: 'agent'; agentTaskId: string | null; runId: string; stepRef?: string | null }
  | { kind: 'flow'; flowId: string; runId: string; stepRef?: string | null }

export type ActionLedgerContext = {
  organizationId: string
  source: ActionSource
  /** The person the call acts as (agents act as whoever runs them). */
  actorUserId: string | null
  /** Set when the write ran because a person approved it. */
  approval?: { approvalId: string; approvedById: string }
  /** Runtime provider id ('nango:slack', 'databricks', an MCP slug…). */
  provider: string
  plane: string
  /** The bare tool name. */
  tool: string
  args: Record<string, unknown>
  /** Only writes are recorded; a read passes straight through. */
  isWrite: boolean
  credential?: PlaneCredential
  mcpConnectionId?: string
}

/** 'nango' | 'mcp' | 'people_ai' | 'native', from a binding's provider. */
export function planeOfProvider(provider: string, mcpConnectionId?: string | null): string {
  if (provider.startsWith('nango:')) return 'nango'
  if (mcpConnectionId) return 'mcp'
  if (provider === 'backstory') return 'people_ai'
  return 'native'
}

// ── Argument summary ─────────────────────────────────────────────────────────

const MAX_STRING = 200
const MAX_ITEMS = 10
const MAX_DEPTH = 3
const MAX_SUMMARY_CHARS = 4000
/** Card numbers and national ids never belong in a summary, whatever key carries them. */
const MASKS: Array<[RegExp, string]> = [
  [/\b\d(?:[ -]?\d){12,18}\b/g, '[number]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[id]'],
]

function shorten(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    let text = value
    for (const [pattern, replacement] of MASKS) text = text.replace(pattern, replacement)
    return text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}… (${value.length} chars)` : text
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return `[${value.length} items]`
    const items = value.slice(0, MAX_ITEMS).map((item) => shorten(item, depth + 1))
    if (value.length > MAX_ITEMS) items.push(`… ${value.length - MAX_ITEMS} more`)
    return items
  }
  if (value && typeof value === 'object') {
    if (depth >= MAX_DEPTH) return `{${Object.keys(value).length} fields}`
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 30).map(([key, item]) => [key, shorten(item, depth + 1)]))
  }
  return value
}

/**
 * What a person needs to recognise the call — "posted 'Q3 numbers…' to
 * #revenue" — and nothing a ledger should keep: secret-named keys and
 * credential-shaped values are redacted (the log redactor's two rules),
 * card/national-id numbers masked, long text cut, and the whole bounded.
 */
export function summarizeArgs(args: unknown): Record<string, unknown> {
  const redacted = redactLogMeta(args && typeof args === 'object' && !Array.isArray(args) ? args : { value: args })
  const summary = shorten(redacted, 0) as Record<string, unknown>
  const json = JSON.stringify(summary ?? {})
  if (json.length <= MAX_SUMMARY_CHARS) return summary ?? {}
  return { fields: Object.keys(summary ?? {}), note: 'Arguments too large to keep; field names only.' }
}

// ── Writing ──────────────────────────────────────────────────────────────────

const BEFORE_IMAGE_TIMEOUT_MS = 8_000

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms) }),
  ]).finally(() => clearTimeout(timer))
}

function connectionRefOf(ctx: ActionLedgerContext): Prisma.InputJsonValue | undefined {
  if (!ctx.credential && !ctx.mcpConnectionId) return undefined
  return {
    actsAs: ctx.credential?.actsAs ?? null,
    ...(ctx.credential?.nango
      ? { nango: { connectionId: ctx.credential.nango.connectionId, providerConfigKey: ctx.credential.nango.providerConfigKey, scope: ctx.credential.nango.scope } }
      : {}),
    ...(ctx.mcpConnectionId ? { mcpConnectionId: ctx.mcpConnectionId } : {}),
  }
}

async function recordAction(ctx: ActionLedgerContext, outcome: { status: 'done' | 'failed'; resultRef?: ResultRef | null; beforeImage?: unknown; error?: string }) {
  try {
    await prisma.agentAction.create({
      data: {
        organizationId: ctx.organizationId,
        sourceKind: ctx.source.kind,
        agentTaskId: ctx.source.kind === 'agent' ? ctx.source.agentTaskId : null,
        flowId: ctx.source.kind === 'flow' ? ctx.source.flowId : null,
        runId: ctx.source.runId,
        stepRef: ctx.source.stepRef ?? null,
        approvalId: ctx.approval?.approvalId ?? null,
        approvedById: ctx.approval?.approvedById ?? null,
        actorUserId: ctx.actorUserId,
        provider: ctx.provider,
        plane: ctx.plane,
        tool: ctx.tool,
        connectionRef: connectionRefOf(ctx),
        argsSummary: summarizeArgs(ctx.args) as Prisma.InputJsonValue,
        resultRef: (outcome.resultRef ?? undefined) as Prisma.InputJsonValue | undefined,
        beforeImage: outcome.beforeImage == null ? undefined : (outcome.beforeImage as Prisma.InputJsonValue),
        status: outcome.status,
        error: outcome.error ? outcome.error.slice(0, 1000) : null,
      },
    })
  } catch (error) {
    apiLogger.error('action ledger write failed', {
      organizationId: ctx.organizationId,
      tool: ctx.tool,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Run one tool call, recording it on the ledger when it is a write.
 *
 * For an update whose compensator can read the record first, the prior values
 * are captured just before the call (bounded; a failed read records no
 * before-image and the entry later says it cannot be restored — never a
 * blocked write). The call's own success or failure is returned/thrown
 * unchanged.
 */
export async function withActionLedger<T>(
  ctx: ActionLedgerContext,
  run: () => Promise<T>,
  deps: {
    proxy?: NangoProxy
    /** When `run` wraps the call (a retry loop), how to reach the tool's own result. */
    resultOf?: (value: T) => unknown
  } = {},
): Promise<T> {
  if (!ctx.isWrite) return run()
  const compensation = compensationFor(ctx)
  let beforeImage: unknown = null
  if (compensation.undoable && compensation.captureBefore && ctx.credential?.nango) {
    try {
      beforeImage = await withDeadline(compensation.captureBefore(ctx.credential.nango, ctx.args, deps.proxy ?? defaultProxy()), BEFORE_IMAGE_TIMEOUT_MS)
    } catch (error) {
      apiLogger.warn('action ledger: could not read the record before an update; it will not be restorable', {
        organizationId: ctx.organizationId,
        tool: ctx.tool,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  let result: T
  try {
    result = await run()
  } catch (error) {
    await recordAction(ctx, { status: 'failed', error: describeUpstreamFailure(error) })
    throw error
  }
  let resultRef: ResultRef | null = null
  try {
    resultRef = compensation.ref?.(deps.resultOf ? deps.resultOf(result) : result, ctx.args) ?? null
  } catch {
    resultRef = null
  }
  await recordAction(ctx, { status: 'done', resultRef, beforeImage })
  return result
}

/**
 * Which agent or flow an approval's run belongs to. decideApproval only knows
 * the run id (an AgentExecution or a FlowRun), so the ledger looks it up.
 */
export async function actionSourceForRun(organizationId: string, runId: string): Promise<ActionSource> {
  const execution = await prisma.agentExecution.findFirst({ where: { id: runId, organizationId }, select: { agentTaskId: true } })
  if (execution) return { kind: 'agent', agentTaskId: execution.agentTaskId, runId }
  const flowRun = await prisma.flowRun.findFirst({ where: { id: runId, organizationId }, select: { flowId: true } })
  if (flowRun) return { kind: 'flow', flowId: flowRun.flowId, runId }
  return { kind: 'agent', agentTaskId: null, runId }
}
