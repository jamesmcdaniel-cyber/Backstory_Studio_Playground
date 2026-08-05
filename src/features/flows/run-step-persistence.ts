// Node types whose FlowRunStep rows are written by the execute-flow ADAPTERS
// (create-at-start + finish-at-end, so the run panel shows live status). The
// interpreter's onStep must skip these or every such step gets a duplicate
// row. Any node type dispatched through runAgent/runAction belongs here —
// including 'knowledge', whose omission double-persisted every knowledge step
// (one adapter row + one interpreter row with an empty input).
const ADAPTER_PERSISTED_TYPES = new Set(['agent', 'tool', 'http', 'ai', 'subflow', 'code', 'knowledge'])

export function shouldPersistInterpreterStep(nodeType: string | undefined): boolean {
  return !nodeType || !ADAPTER_PERSISTED_TYPES.has(nodeType)
}

/**
 * A code step executes with the WHOLE run context (context.steps = every prior
 * step's output) — but persisting that copy made step rows quadratic in run
 * size and duplicated the data already on each step's own row. The persisted
 * input keeps everything the code actually declared plus the small context
 * scalars, and replaces context.steps with an omission marker.
 */
export function persistedCodeStepInput(config: Record<string, unknown>): Record<string, unknown> {
  const context = config.context
  if (!context || typeof context !== 'object' || Array.isArray(context)) return config
  return {
    ...config,
    context: {
      ...(context as Record<string, unknown>),
      steps: '[prior step outputs — available to the code as steps.*; see each step’s own row]',
    },
  }
}
