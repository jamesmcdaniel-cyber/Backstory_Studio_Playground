// Derives the run-level `waiting` object exposed by the runs API from a run's
// status + steps. A waiting agent step persists its pause reason in
// output.waiting ({ kind, question?, approvalId? }); this surfaces what the
// run is blocked on so reply/approval UIs know what to render.
//
// A run can be blocked on MORE THAN ONE pause at a time: a loop with
// concurrency above 1 (or a parallel node whose branches each ask something)
// leaves one waiting row per iteration. `deriveRunWaitingAll` lists them all,
// each tagged with the step key its reply must carry; `deriveRunWaiting` keeps
// its original single-pause answer for the callers that only need "what is this
// run blocked on".

export type RunWaiting = {
  nodeId: string
  /**
   * 'unknown' covers a missing, unparseable, or unrecognized `waiting.kind` —
   * e.g. a legacy row recorded before pause reasons were persisted, or a
   * redacted marker sitting where a real kind should be. It must never be
   * reported as 'input': an approval pause misreported as a question asks the
   * user for text nobody is going to read.
   */
  kind: 'input' | 'approval' | 'unknown'
  question?: string
  /**
   * The exact step row this pause belongs to, when it is one iteration of a
   * loop/parallel body (`${nodeId}#${index}`). A reply must carry it so it
   * resolves the iteration it was written for. Absent for a plain, un-iterated
   * pause — there is nothing to disambiguate.
   */
  stepKey?: string
  /** 1-based iteration number, for display ("Item 3"). Absent when stepKey is. */
  iteration?: number
}

type WaitingStep = { nodeId: string; status: string; output?: unknown }

function waitingInfo(output: unknown): { kind?: string; question?: string } | undefined {
  return (output as { waiting?: { kind?: string; question?: string } } | null | undefined)?.waiting
}

function toRunWaiting(step: WaitingStep): RunWaiting {
  const info = waitingInfo(step.output)
  // `node#2` → iteration 3 of the loop body. Nested loops append further
  // suffixes; the LAST one is this row's own iteration.
  const parts = step.nodeId.split('#')
  const index = parts.length > 1 ? Number(parts[parts.length - 1]) : NaN
  return {
    nodeId: step.nodeId,
    kind:
      info?.kind === 'approval'
        ? ('approval' as const)
        : info?.kind === 'input'
          ? ('input' as const)
          : ('unknown' as const),
    question: info?.question,
    ...(parts.length > 1 ? { stepKey: step.nodeId } : {}),
    ...(Number.isInteger(index) ? { iteration: index + 1 } : {}),
  }
}

/**
 * Every pause a `waiting` run is currently blocked on, in step order.
 *
 * Container rows (the loop/parallel node's own `waiting` row, persisted for
 * display) are dropped: only the leaf inside actually resumes, and the
 * container row carries no `output.waiting`. When NO row carries one — a legacy
 * run recorded before pause reasons were persisted — the rows are kept as they
 * are, so those runs still surface a pause.
 */
export function deriveRunWaitingAll(status: string, steps: WaitingStep[]): RunWaiting[] {
  if (status !== 'waiting') return []
  const waiting = steps.filter((step) => step.status === 'waiting')
  const described = waiting.filter((step) => waitingInfo(step.output) !== undefined)
  const rows = described.length ? described : waiting
  // A stale unresolved row and the live row for the SAME step key are one
  // pause; steps arrive in `order` asc, so the later row wins.
  const byKey = new Map<string, WaitingStep>()
  for (const step of rows) byKey.set(step.nodeId, step)
  return [...byKey.values()].map(toRunWaiting)
}

export type WaitingReplyChoice<T> =
  | { target: T }
  | { error: string; code: 'FLOW_REPLY_AMBIGUOUS' | 'FLOW_REPLY_TARGET_GONE' }

/**
 * Route ONE reply to the pause it answers.
 *
 * - a key that names a live pause → that pause, always;
 * - no key and exactly one pause → that pause (every reply written before
 *   per-iteration keying carries no key, and must keep working);
 * - no key and several pauses → refuse. Picking one silently would answer the
 *   wrong item AND consume the reply the others are still waiting for.
 * - a key that names nothing → refuse; that pause already moved on.
 *
 * Returns null when the run has no pause to answer at all — the caller decides
 * what that means (the resume path simply carries on and re-walks the graph).
 */
export function chooseWaitingReply<T extends { nodeId: string }>(
  pending: T[],
  replyStepKey?: string,
): WaitingReplyChoice<T> | null {
  if (!pending.length) return null
  if (replyStepKey) {
    const match = pending.find((entry) => entry.nodeId === replyStepKey)
    return match
      ? { target: match }
      : {
          error: 'That reply was written for a step that is no longer waiting — open the run to see what it needs now.',
          code: 'FLOW_REPLY_TARGET_GONE',
        }
  }
  if (pending.length === 1) return { target: pending[0] }
  return {
    error: `This run is waiting on ${pending.length} reviews at once — answer the one you mean, so your reply reaches the right item.`,
    code: 'FLOW_REPLY_AMBIGUOUS',
  }
}

export function deriveRunWaiting(status: string, steps: WaitingStep[]): RunWaiting | null {
  if (status !== 'waiting') return null
  // Steps arrive ordered by `order` asc; the LAST waiting step is the live
  // pause. A resume resolves old waiting rows, but if a stale one survives
  // (legacy runs) the latest pause must still win so reply UIs target it.
  let step: WaitingStep | undefined
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].status === 'waiting') {
      step = steps[i]
      break
    }
  }
  if (!step) return null
  return toRunWaiting(step)
}
