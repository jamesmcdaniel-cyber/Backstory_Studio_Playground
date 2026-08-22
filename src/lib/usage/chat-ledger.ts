/**
 * Ledger attribution for interactive chat surfaces: the follow-up Q&A over a
 * completed run (/api/chat) and the per-agent assistant thread
 * (/api/agents/[id]/chat).
 *
 * Extracted to a pure function for the same reason as
 * src/lib/flows/ai-step-ledger.ts's buildFlowAiLedgerContext — the shape
 * (surface 'run.chat', the specific chatting user) is unit-testable without
 * a model call or a database. The return type matches
 * @/lib/llm/model-runner's LedgerContext structurally; it is not imported
 * from here to keep this module import-free and trivially testable.
 */
export type ChatLedgerContext = {
  organizationId: string
  userId?: string | null
  surface: 'run.chat'
}

export function buildChatLedgerContext(input: { organizationId: string; userId?: string | null }): ChatLedgerContext {
  return {
    organizationId: input.organizationId,
    userId: input.userId ?? null,
    surface: 'run.chat',
  }
}
