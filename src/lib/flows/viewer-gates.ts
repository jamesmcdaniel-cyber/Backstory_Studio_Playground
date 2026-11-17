/**
 * The builder's read-only banner, worded for WHY this viewer can't edit.
 *
 * There are two different reasons and they need different next steps: the
 * flow's sharing makes it owner-edit-only (ask the owner), or the viewer's
 * workspace role can't edit flows at all (ask an admin). The banner used to say
 * "only its owner can edit it — you can run it" to everyone, which was wrong on
 * both counts for a VIEWER member: the owner can't help, and they can't run it.
 */
export function viewOnlyNotice({ canWriteFlows, canRun }: { canWriteFlows: boolean; canRun: boolean }): string {
  if (!canWriteFlows) {
    return canRun
      ? 'View only — your workspace role can run flows but not edit them. Ask an admin to change your role.'
      : 'View only — your workspace role can open flows but not edit or run them. Ask an admin to change your role.'
  }
  return canRun
    ? 'View only — you can run this flow, but only its owner can edit it.'
    : 'View only — only its owner can edit this flow.'
}

/**
 * Which card-menu actions the Flows list offers for one flow.
 *
 * Driven by the per-flow facts GET /api/flows serializes for THIS viewer
 * (`canEdit` already folds in flow.write; `external` marks a cross-workspace
 * guest, whose org-scoped writes 404) plus the viewer's own flow.write for
 * actions that create a NEW flow. Anything the server would refuse is not
 * offered.
 */
export function flowCardActions(
  flow: { canEdit?: boolean; external?: boolean },
  canWriteFlows: boolean,
): { edit: boolean; publish: boolean; move: boolean; delete: boolean; duplicate: boolean } {
  const editable = flow.canEdit === true && !flow.external
  return { edit: editable, publish: editable, move: editable, delete: editable, duplicate: canWriteFlows }
}
