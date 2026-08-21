/**
 * Ledger attribution for a flow's standalone 'ai' step (execute-flow.ts).
 *
 * Extracted to a pure function so the shape — surface 'flow_ai' (not
 * 'agent_turn', which belongs to the agent runtime's own turns) plus the
 * step's own row id — is unit-testable without spinning up a full flow run.
 * The return type matches @/lib/llm/model-runner's LedgerContext
 * structurally; it is not imported from here to keep this module import-free
 * and trivially testable.
 */
export type FlowAiLedgerContext = {
  organizationId: string
  userId?: string | null
  surface: 'flow_ai'
  flowRunId: string
  flowRunStepId: string
}

export function buildFlowAiLedgerContext(input: {
  organizationId: string
  userId?: string | null
  flowRunId: string
  flowRunStepId: string
}): FlowAiLedgerContext {
  return {
    organizationId: input.organizationId,
    userId: input.userId ?? null,
    surface: 'flow_ai',
    flowRunId: input.flowRunId,
    flowRunStepId: input.flowRunStepId,
  }
}
