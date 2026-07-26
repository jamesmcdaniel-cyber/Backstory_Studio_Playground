// Node types whose FlowRunStep rows are written by the execute-flow ADAPTERS
// (create-at-start + finish-at-end, so the run panel shows live status). The
// interpreter's onStep must skip these or every such step gets a duplicate
// row. Any node type dispatched through runAgent/runAction belongs here.
const ADAPTER_PERSISTED_TYPES = new Set(['agent', 'tool', 'http', 'ai', 'subflow', 'code'])

export function shouldPersistInterpreterStep(nodeType: string | undefined): boolean {
  return !nodeType || !ADAPTER_PERSISTED_TYPES.has(nodeType)
}
