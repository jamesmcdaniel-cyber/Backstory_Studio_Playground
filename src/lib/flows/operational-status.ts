/**
 * The compact execution state shown on a flow card.
 *
 * FlowRun rows are created as `running` before the queue consumer starts its
 * first step. That makes the presence of a step the durable boundary between
 * queued and actually running without adding a second source of truth.
 */
export type FlowOperationalStatus = 'idle' | 'queued' | 'running' | 'blocked'

type ActiveRun = {
  status: string
  stepCount: number
}

export function deriveFlowOperationalStatus(runs: ActiveRun[]): FlowOperationalStatus {
  // A waiting run needs a person, timer, approval, or callback. Surface that
  // before other work so the card does not hide an action-needed run behind a
  // newer concurrent execution.
  if (runs.some((run) => run.status === 'waiting')) return 'blocked'

  // Cancelling has already been picked up by the runtime. A normal run crosses
  // the same boundary as soon as its first durable step row exists.
  if (runs.some((run) => run.status === 'cancelling' || (run.status === 'running' && run.stepCount > 0))) {
    return 'running'
  }

  if (runs.some((run) => run.status === 'running')) return 'queued'
  return 'idle'
}
