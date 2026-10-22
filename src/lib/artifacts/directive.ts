/** Explicit author instruction, not a tool-result or retrieved-content trigger. */
export function requestsArtifact(...instructions: Array<string | null | undefined>): boolean {
  return instructions.some(text => /(?:^|\s)@\s?artifact\b/i.test(text ?? ''))
}

/**
 * Runs whose input is a request the platform user typed themselves: Run (and
 * the agent chat), and an artifact's own chat. Everything else carries text
 * from elsewhere — a Slack message, an inbound email, a webhook or form body,
 * a flow step's upstream output — which must not switch on app mode.
 */
const USER_TYPED_REQUEST_TRIGGERS = new Set(['manual', 'artifact'])

/**
 * Whether @artifact mode applies to a run: the agent's own instructions ask
 * for it, or a request the user typed does. An ROI build's deliverable is its
 * JSON contract, never an app: @artifact neither steers nor fails it.
 */
export function artifactModeApplies(triggerType: string, objective: string | null | undefined, request?: string | null): boolean {
  if (triggerType === 'roi_analysis') return false
  return requestsArtifact(objective, USER_TYPED_REQUEST_TRIGGERS.has(triggerType) ? request : null)
}

export const ARTIFACT_DIRECTIVE = `@artifact mode is enabled by the user. Deliver a complete executable interactive application and save it through the normal artifact result path, linked to this agent. Output the complete HTML document or React/TSX module, not just prose, a plan, a screenshot, or a download link. Implement the requested interactions and validation; use HTML/CSS and JavaScript/TypeScript for UI, the supported worker Python API for requested Python computations, and useArtifactState for durable editable data. Do not include Python as decoration or claim a calculation ran when it did not. Use the runtime contract below. When the task lacks details, choose sensible reversible defaults and label synthetic fixtures. If genuinely blocked, state the blocker rather than claim the app was built.`
