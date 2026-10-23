// Routes a reply aimed at an agent execution that may be OWNED BY A FLOW RUN.
//
// When a flow's agent step pauses with a question, the user can answer from
// the agent activity pane instead of the flow UI. Resuming only the bare
// agent execution there leaves the FlowRun stranded `waiting` forever — the
// reply has to resume the FLOW, which re-enters the paused agent step with
// the reply itself.

import type { RunWaiting } from './run-waiting'

export type ReplyTarget = 'flow' | 'agent' | 'approval-block' | 'external-block'

/**
 * Decide what a reply to an agent execution should resume.
 *
 * - 'flow': the execution is the live waiting step (kind 'input') of a
 *   `waiting` flow run — resume the flow so run and step advance together.
 * - 'approval-block': the run's live wait is an approval — the reply endpoint
 *   must never decide approvals, so the caller rejects with a clear error.
 * - 'agent': no flow owns this pause (pure agent run), the run already moved
 *   on (not `waiting` — resumed elsewhere, or terminally swept: an abandoned
 *   execution can go waiting_for_input inside a run that already `failed`,
 *   where the bare agent resume still lets the zombie finish and write
 *   memory, harmlessly), or the step is not the run's live waiting step —
 *   fall through to the existing bare agent resume.
 */
export function resolveReplyTarget(
  run: { status: string } | null | undefined,
  step: { nodeId: string } | null | undefined,
  waiting: RunWaiting | null,
): ReplyTarget {
  if (!run || !step) return 'agent'
  if (run.status !== 'waiting') return 'agent'
  if (!waiting || waiting.nodeId !== step.nodeId) return 'agent'
  if (waiting.kind === 'approval') return 'approval-block'
  // An external agent answers only through its own reply API.
  if (waiting.kind === 'external') return 'external-block'
  return 'flow'
}
