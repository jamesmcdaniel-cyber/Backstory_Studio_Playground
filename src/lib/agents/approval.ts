/**
 * Approval gate for outbound writes.
 *
 * When an agent is configured with `requireApproval`, its write-plane tool
 * calls (Nango delivery: Slack/Gmail/Salesforce) are not executed inline.
 * Instead an ApprovalRequest is created and the model is told the action is
 * queued; an approver later approves (the write runs) or rejects (it's
 * dropped). Every decision is audited. This avoids pausing/resuming the whole
 * multi-turn run while still gating side effects.
 */

import { prisma } from '@/lib/prisma'
import { recordAudit } from '@/lib/audit'
import { resolveNangoConnection, type DeliveryCapability } from '@/lib/nango/delivery'
import { findNangoWriteTool, PROVIDER_CONFIG_KEYS } from '@/lib/nango/provider-tools'
import { detectPiiCategories } from '@/lib/security/pii-egress'

/** Delivery planes, used only to label an approval with a friendly capability. */
const DELIVERY_PLANE = /^nango:(slack|gmail|salesforce)$/

/**
 * Should this tool call be queued for human approval instead of run inline?
 *
 * Gates EVERY Nango write plane (not just delivery) when the agent opts in via
 * `requireApproval`. `decideApproval` can now execute any approved Nango write
 * (findNangoWriteTool), so gating github/jira/hubspot/… writes no longer risks a
 * queue-then-noop. `isWrite` comes from the tool's binding, so read tools on a
 * write plane (e.g. slack_read_messages) are never gated.
 */
export function requiresApproval(
  agentMetadata: Record<string, unknown> | null | undefined,
  provider: string,
  isWrite: boolean,
  options: { injectionTainted?: boolean } = {},
): boolean {
  if (isWrite !== true || !provider.startsWith('nango:')) return false
  // A TAINTED run — one that has already read content flagged as
  // injection-shaped this run — loses the right to write unattended, whatever
  // the agent's own setting says. This is the deterministic answer to the one
  // scenario no argument scan can catch: a persuaded model summarising
  // sensitive-but-not-credential data into an outbound channel. The scan that
  // sets the taint never blocks a READ (judgment calls stay out of the
  // deterministic layer); it converts the next WRITE into a human decision,
  // which costs one approval on a false positive instead of a broken run.
  //
  // Scoped to nango planes deliberately: decideApproval can EXECUTE an
  // approved Nango write, so gating them queues real work. Gating a plane the
  // decider cannot execute would queue-then-noop — the bug this gate's history
  // already paid for once. MCP writes on tainted runs are the per-step
  // toolPolicy's job.
  if (options.injectionTainted === true) return true
  return agentMetadata?.requireApproval === true
}

/** The delivery capability for a provider (for the approval summary), or null. */
export function capabilityFromProvider(provider: string): DeliveryCapability | null {
  const match = DELIVERY_PLANE.exec(provider)
  return match ? (match[1] as DeliveryCapability) : null
}

export async function createApproval(input: {
  organizationId: string
  executionId: string
  userId: string
  provider: string
  tool: string
  args: Record<string, unknown>
  /** The run read injection-shaped content before proposing this write. */
  injectionTainted?: boolean
}): Promise<{ id: string }> {
  const capability = capabilityFromProvider(input.provider)

  // The approver's ONE job is deciding whether this send should happen, and
  // the summary was `tool (capability)` — which tool, not what it carries.
  // A persuaded model summarising sensitive data into an approved channel is
  // exactly the call a human is gating here, and they cannot catch what they
  // cannot see. So the summary now says what the payload CARRIES (PII
  // categories, never values) and whether the run was tainted; the payload
  // itself is stored for the detail view either way.
  const piiCategories = detectPiiCategories(JSON.stringify(input.args ?? {}))
  const riskNotes = [
    ...(input.injectionTainted
      ? ['⚠ this run read content flagged as a possible injection attempt']
      : []),
    ...(piiCategories.length ? [`carries ${piiCategories.join(', ')}`] : []),
  ]
  const summary = `${input.tool} (${capability ?? input.provider})${riskNotes.length ? ` — ${riskNotes.join('; ')}` : ''}`

  const approval = await prisma.approvalRequest.create({
    data: {
      organizationId: input.organizationId,
      executionId: input.executionId,
      tool: input.tool,
      summary,
      payload: {
        provider: input.provider,
        capability,
        args: input.args,
        userId: input.userId,
        risk: { injectionTainted: input.injectionTainted === true, piiCategories },
      } as never,
      status: 'pending',
    },
  })
  await recordAudit({
    organizationId: input.organizationId,
    executionId: input.executionId,
    actorUserId: input.userId,
    actorKind: 'agent',
    action: 'approval.requested',
    tool: input.tool,
    resourceType: input.provider,
    resourceId: approval.id,
    payload: input.args,
  })
  return { id: approval.id }
}

export interface ResumeInfo {
  executionId: string
  agentId: string
  organizationId: string
  userId: string
  reply: string
}

export interface FlowResumeInfo {
  flowRunId: string
  flowId: string
  organizationId: string
  userId: string
  reply: string
  /** Non-manual runs executed the published graph; resume against the same. */
  usePublished: boolean
}

export interface DecideResult {
  // 'superseded' = the paused run resumed without this approval being decided
  // (its step re-queued a fresh one); deciding it is a no-op reported as-is.
  status: 'approved' | 'rejected' | 'superseded'
  executed: boolean
  /** Set when a suspended run should be resumed with the decision result — the
   *  caller (approval route) triggers resumeAgentExecution to avoid a cycle. */
  resume?: ResumeInfo
  /** Set when a FLOW run is paused on this approval (tool-step approval) — the
   *  caller (approval route) triggers runFlowExecution to avoid a cycle. */
  resumeFlow?: FlowResumeInfo
}

/** Resume info for a run suspended on this approval, or undefined if not suspended. */
async function resumeInfoFor(executionId: string, organizationId: string, reply: string): Promise<ResumeInfo | undefined> {
  const execution = await prisma.agentExecution.findFirst({ where: { id: executionId, organizationId } })
  if (!execution || execution.status !== 'waiting_for_approval' || !execution.agentTaskId) return undefined
  return { executionId: execution.id, agentId: execution.agentTaskId, organizationId, userId: execution.userId, reply }
}

/** Resume info for a FLOW run paused on this approval (its tool step created
 *  the approval with executionId = the FlowRun id), or undefined. */
async function flowResumeInfoFor(
  executionId: string,
  organizationId: string,
  reply: string,
  fallbackUserId?: string,
): Promise<FlowResumeInfo | undefined> {
  const run = await prisma.flowRun.findFirst({
    where: { id: executionId, organizationId, status: 'waiting' },
    select: { id: true, flowId: true, userId: true, trigger: true },
  })
  if (!run) return undefined
  const userId = run.userId ?? fallbackUserId
  if (!userId) return undefined
  const triggerType = (run.trigger as { type?: string } | null)?.type
  return {
    flowRunId: run.id,
    flowId: run.flowId,
    organizationId,
    userId,
    reply,
    usePublished: Boolean(triggerType && triggerType !== 'manual'),
  }
}

/**
 * Approve (execute the queued write) or reject (drop it) an approval, scoped to
 * the deciding user's organization. Idempotent: a non-pending request returns
 * its current state without re-executing.
 */
export async function decideApproval(input: {
  approvalId: string
  organizationId: string
  deciderUserId: string
  approve: boolean
}): Promise<DecideResult> {
  const approval = await prisma.approvalRequest.findFirst({
    where: { id: input.approvalId, organizationId: input.organizationId },
  })
  if (!approval) throw new Error('Approval not found')
  if (approval.status !== 'pending') {
    // Idempotent replay — but if the fire-and-forget flow resume crashed after
    // the decision was recorded, the run is stranded `waiting`. Hand the caller
    // resume info again so re-POSTing the decision un-strands it. (Superseded
    // approvals never resume anything — see flowResumeRetryInfo.)
    const resumeFlow = await flowResumeRetryInfo(approval, input.organizationId)
    return { status: decidedStatus(approval.status), executed: false, ...(resumeFlow ? { resumeFlow } : {}) }
  }

  if (!input.approve) {
    // Atomic claim: only the request that flips pending→rejected proceeds.
    const claimed = await prisma.approvalRequest.updateMany({
      where: { id: approval.id, organizationId: input.organizationId, status: 'pending' },
      data: { status: 'rejected', decidedById: input.deciderUserId, decidedAt: new Date() },
    })
    if (claimed.count !== 1) return currentDecision(input.approvalId, input.organizationId)
    await recordAudit({
      organizationId: input.organizationId,
      executionId: approval.executionId,
      actorUserId: input.deciderUserId,
      action: 'approval.rejected',
      tool: approval.tool,
      resourceId: approval.id,
    })
    const rejectedReply = rejectedDecisionReply(approval.id)
    const resume = await resumeInfoFor(approval.executionId, input.organizationId, rejectedReply)
    const requesterUserId = (approval.payload as { userId?: string } | null)?.userId
    const resumeFlow = resume ? undefined : await flowResumeInfoFor(approval.executionId, input.organizationId, rejectedReply, requesterUserId)
    return { status: 'rejected', executed: false, ...(resume ? { resume } : {}), ...(resumeFlow ? { resumeFlow } : {}) }
  }

  // Approve: atomically claim the pending request (pending→approving) so exactly
  // ONE approver executes the delivery. Delivery (Nango) is NOT idempotent, and
  // two concurrent approvals both passed the read above — the claim is the race
  // guard: a losing caller sees status != pending and is a no-op.
  const claimed = await prisma.approvalRequest.updateMany({
    where: { id: approval.id, organizationId: input.organizationId, status: 'pending' },
    data: { status: 'approving', decidedById: input.deciderUserId, decidedAt: new Date() },
  })
  if (claimed.count !== 1) return currentDecision(input.approvalId, input.organizationId)

  const payload = approval.payload as {
    provider: string
    capability: DeliveryCapability | null
    args: Record<string, unknown>
    userId: string
  }
  let executed = false
  let writeResult: unknown = null
  try {
    // Dispatch on the RECORDED (bare) TOOL NAME across the full Nango write
    // registry — never on the capability/provider alone (that would run a
    // plane's send tool for any approval on it: approving salesforce_update
    // would CREATE, approving a read-shaped call would post its text). Require
    // the resolved spec's provider to match the recorded provider before using
    // that provider's connection. No spec / mismatch / no connection → fail
    // closed (`executed` stays false → audited approval.approved_noexec).
    const spec = findNangoWriteTool(approval.tool)
    if (spec && `nango:${spec.provider}` === payload.provider) {
      const configKeys = PROVIDER_CONFIG_KEYS[spec.provider] ?? [spec.provider]
      const connection = await resolveNangoConnection(input.organizationId, configKeys, payload.userId)
      if (connection) {
        writeResult = await spec.run(connection, payload.args)
        executed = true
      }
    }
  } catch (error) {
    // Delivery failed after we claimed it — mark failed (not back to pending) so
    // a possibly-partial, non-idempotent write is never silently re-approved.
    await prisma.approvalRequest.update({ where: { id: approval.id, organizationId: input.organizationId }, data: { status: 'failed' } }).catch(() => undefined)
    await recordAudit({
      organizationId: input.organizationId,
      executionId: approval.executionId,
      actorUserId: input.deciderUserId,
      action: 'approval.failed',
      tool: approval.tool,
      resourceType: payload.provider,
      resourceId: approval.id,
    }).catch(() => undefined)
    throw error
  }

  await prisma.approvalRequest.update({
    where: { id: approval.id, organizationId: input.organizationId },
    data: { status: 'approved' },
  })
  await recordAudit({
    organizationId: input.organizationId,
    executionId: approval.executionId,
    actorUserId: input.deciderUserId,
    // 'approval.approved' is a TOOL_USAGE_ACTIONS row (usage-profile.ts) that
    // counts as a real outbound delivery. Only emit it when the write actually
    // ran; if the delivery was skipped (e.g. the Nango connection was removed
    // between request and decision, so spec.run never ran) record a distinct,
    // usage-profile-ignored action so a delivery that never happened isn't
    // counted as one.
    action: executed ? 'approval.approved' : 'approval.approved_noexec',
    tool: approval.tool,
    resourceType: payload.provider,
    resourceId: approval.id,
    payload: payload.args,
  })
  const approvedReply = approvedDecisionReply(approval.id, executed, writeResult)
  const resume = await resumeInfoFor(approval.executionId, input.organizationId, approvedReply)
  const resumeFlow = resume ? undefined : await flowResumeInfoFor(approval.executionId, input.organizationId, approvedReply, payload.userId)
  return { status: 'approved', executed, ...(resume ? { resume } : {}), ...(resumeFlow ? { resumeFlow } : {}) }
}

/** Report the settled decision for a request another caller already claimed. */
async function currentDecision(approvalId: string, organizationId: string): Promise<DecideResult> {
  const current = await prisma.approvalRequest.findFirst({ where: { id: approvalId, organizationId } })
  // 'approving' = another approver is mid-execution; surface it as approved
  // (not executed by us) rather than implying it's still actionable.
  const resumeFlow = current ? await flowResumeRetryInfo(current, organizationId) : undefined
  return { status: decidedStatus(current?.status ?? 'approved'), executed: false, ...(resumeFlow ? { resumeFlow } : {}) }
}

/**
 * Map a stored approval status to the reported decision status. A superseded
 * approval (its run resumed and re-queued a fresh one before this one was
 * decided) must be reported faithfully — never as approved, which would imply
 * the write ran. Everything else non-rejected reads as approved ('approving'
 * = a concurrent approver is mid-execution).
 */
function decidedStatus(status: string): DecideResult['status'] {
  if (status === 'rejected') return 'rejected'
  if (status === 'superseded') return 'superseded'
  return 'approved'
}

// Decision replies carry the approvalId so a resuming flow step only consumes
// a decision that correlates with the approval IT paused on (loops/parallel
// can have several approvals in flight for one run).
function approvedDecisionReply(approvalId: string, executed: boolean, result: unknown): string {
  return JSON.stringify({ status: 'approved', approvalId, executed, result })
}

function rejectedDecisionReply(approvalId: string): string {
  return JSON.stringify({ status: 'rejected', approvalId, message: 'The approver rejected this action. Do not retry it; continue without it.' })
}

/**
 * Retry path for a flow run stranded on an ALREADY-decided approval: the
 * decision was recorded but the fire-and-forget resume may have crashed. When
 * the run is still `waiting`, rebuild the same reply the normal decision path
 * sent so the caller can trigger the resume again. Undecided states
 * ('approving', 'failed', 'superseded') never resume — the winner/failure path
 * owns the first two, and a superseded approval's run already moved on.
 */
async function flowResumeRetryInfo(
  approval: { id: string; status: string; executionId: string; payload: unknown },
  organizationId: string,
): Promise<FlowResumeInfo | undefined> {
  if (approval.status !== 'approved' && approval.status !== 'rejected') return undefined
  const reply =
    approval.status === 'approved'
      ? approvedDecisionReply(approval.id, true, null)
      : rejectedDecisionReply(approval.id)
  const requesterUserId = (approval.payload as { userId?: string } | null)?.userId
  return flowResumeInfoFor(approval.executionId, organizationId, reply, requesterUserId)
}
