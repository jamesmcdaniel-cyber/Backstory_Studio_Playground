/** Explicit author instruction, not a tool-result or retrieved-content trigger. */
export function requestsArtifact(...instructions: Array<string | null | undefined>): boolean {
  return instructions.some(text => /(?:^|\s)@\s?artifact\b/i.test(text ?? ''))
}

export const ARTIFACT_DIRECTIVE = `@artifact mode is enabled by the user. Deliver a complete executable interactive application and save it through the normal artifact result path, linked to this agent. Output the complete HTML document or React/TSX module, not just prose, a plan, a screenshot, or a download link. Implement the requested interactions and validation; use HTML/CSS and JavaScript/TypeScript for UI, the supported worker Python API for requested Python computations, and useArtifactState for durable editable data. Do not include Python as decoration or claim a calculation ran when it did not. Use the runtime contract below. When the task lacks details, choose sensible reversible defaults and label synthetic fixtures. If genuinely blocked, state the blocker rather than claim the app was built.`
