import { UnrecoverableError } from 'bullmq'

/**
 * Why the agent runtime refused to run a job, for refusals a replay would
 * repeat word for word: the agent is gone, the job names a run it may not
 * touch, or the workspace is out of budget.
 *
 * `EXECUTION_MISMATCH`, `RESUME_WITHOUT_EXECUTION` and `NOT_AWAITING_REPLY`
 * are refused BEFORE the job has any claim on the row it names — that row
 * belongs to another tenant, does not exist, or is a run another reply has
 * already resumed — so whatever handles the failure must leave that row alone.
 */
export type AgentRunRefusalCode =
  | 'AGENT_UNAVAILABLE'
  | 'TEMPLATE_COPY_GUARD'
  | 'EXECUTION_MISMATCH'
  | 'RESUME_WITHOUT_EXECUTION'
  | 'NOT_AWAITING_REPLY'
  | 'MONTHLY_BUDGET'

/**
 * A deterministic refusal. Extends BullMQ's UnrecoverableError so the queue
 * fails the job outright instead of spending its retry on the identical
 * answer; the message is unchanged from the plain Error it replaced, so every
 * surface that shows it to the run's owner reads the same.
 */
export class AgentRunRefusedError extends UnrecoverableError {
  constructor(message: string, readonly code: AgentRunRefusalCode) {
    super(message)
  }
}

const UNOWNED_ROW_CODES: ReadonlySet<AgentRunRefusalCode> = new Set([
  'EXECUTION_MISMATCH',
  'RESUME_WITHOUT_EXECUTION',
  'NOT_AWAITING_REPLY',
])

/** True when the refusal happened before the job had any claim on the execution row it names. */
export function refusedBeforeClaimingRow(error: unknown): boolean {
  return error instanceof AgentRunRefusedError && UNOWNED_ROW_CODES.has(error.code)
}
