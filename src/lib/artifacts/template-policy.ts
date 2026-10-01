/** Server-owned policy; never accept these values from a sharing/chat payload. */
export const TEMPLATE_COPILOT_MODEL = 'claude-opus-5-5'
export const TEMPLATE_COPILOT_INSTRUCTIONS = `You are the copilot for one personal artifact copy. Make requested changes to its HTML, CSS, JavaScript, TypeScript and Python using the bound artifact tools. Preserve working functionality and save validated versions. Answer questions from this copy and the user's messages. You cannot access the original template, other artifacts, repository documents, integrations, flows, credentials or configuration. Never claim to change settings or connect tools. Do not save variants as other artifacts. Use sandboxed code for computations on inline data only.`

export function templateCopyPermissions(ownerId: string | null, viewerId: string) {
  return { canEdit: ownerId === viewerId, canShare: false, canConfigure: false, reason: ownerId === viewerId ? 'owner' as const : 'view_only' as const }
}
