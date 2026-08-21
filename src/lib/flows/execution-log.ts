export type ExecutionLogStep = {
  nodeId: string
  label?: string
  status: string
  order: number
  error?: string | null
  warnings?: string[] | null
}

export type ExecutionLogRun = {
  status: string
  startedAt: string
  finishedAt: string | null
  error?: string | null
  trigger?: { type?: string; [key: string]: unknown } | null
  steps: ExecutionLogStep[]
  /** Persisted at finalize (execute-flow.ts) from the FULL step set. Absent on
   *  pre-migration rows / older cached payloads — only then does
   *  executionIsDegraded fall back to inferring over `steps`. */
  degraded?: boolean
}

/** Short, stable duration text for run-history tables. */
export function executionDuration(run: Pick<ExecutionLogRun, 'startedAt' | 'finishedAt'>): string {
  if (!run.finishedAt) return '—'
  const milliseconds = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—'
  if (milliseconds < 1000) return `${milliseconds}ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`
  return `${Math.floor(milliseconds / 60_000)}m ${Math.floor((milliseconds % 60_000) / 1000)}s`
}

export function executionTriggerLabel(trigger: ExecutionLogRun['trigger']): string {
  const type = typeof trigger?.type === 'string' && trigger.type.trim() ? trigger.type : 'manual'
  return type.charAt(0).toUpperCase() + type.slice(1)
}

/** The most useful one-line explanation available for a run list row. */
export function executionFailureSummary(run: Pick<ExecutionLogRun, 'status' | 'error' | 'steps'>): string {
  if (run.error?.trim()) return run.error.trim()
  const failedStep = run.steps.find((step) => step.status === 'failed' && step.error?.trim())
  if (failedStep?.error) return failedStep.error.trim()
  const warning = run.steps.flatMap((step) => step.warnings ?? []).find((entry) => entry.trim())
  if (warning) return warning.trim()
  if (run.status === 'failed') return 'Run failed before an error detail was recorded.'
  return ''
}

export function executionIsDegraded(run: Pick<ExecutionLogRun, 'status' | 'steps' | 'degraded'>): boolean {
  if (run.degraded !== undefined) return run.degraded
  return run.status === 'succeeded' && run.steps.some(
    (step) => step.status === 'failed' || (step.warnings?.length ?? 0) > 0,
  )
}

/** Resolve a persisted step id against the immutable graph snapshot for that run. */
export function executionStepLabel(graphSnapshot: unknown, nodeId: string): string {
  const [baseId, itemIndex] = nodeId.split('#', 2)
  const graph = graphSnapshot && typeof graphSnapshot === 'object' ? graphSnapshot as { nodes?: unknown } : null
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const node = nodes.find((candidate) => (
    candidate && typeof candidate === 'object' && (candidate as { id?: unknown }).id === baseId
  )) as { type?: unknown; data?: unknown } | undefined

  let label = nodeId
  if (node) {
    const data = node.data && typeof node.data === 'object' ? node.data as { label?: unknown } : null
    if (typeof data?.label === 'string' && data.label.trim()) label = data.label.trim()
    else if (typeof node.type === 'string' && node.type) label = node.type.charAt(0).toUpperCase() + node.type.slice(1)
    else label = baseId
  }
  if (itemIndex !== undefined && /^\d+$/.test(itemIndex)) return `${label} · item ${Number(itemIndex) + 1}`
  return label
}
