/**
 * Whose saved HTTP credential a run may act through.
 *
 * A shared flow's HTTP step, and an agent's HTTP tools, go out on the RUNNER's
 * own credential. The builder's picker already offered only the viewer's own
 * rows plus legacy unowned ones (`/api/http-credentials?scope=bindable`), but
 * run validation and the runtime checked the workspace alone — so a member
 * pressing Run on someone else's flow sent that person's personal key, and
 * the audit attributed the call to the member who pressed Run.
 *
 * The rule: a personal credential is usable only by its owner; a legacy
 * unowned row (userId null) by anyone in the workspace. Scheduled, webhook,
 * poll and event runs act as the flow's owner, so the owner's own credential
 * keeps working there. Warehouse credentials are resolved by their own
 * preference ladder (lib/warehouse/credentials) and do not use this rule.
 *
 * Pure (no server imports): run validation and the runtime share it.
 */

export function httpCredentialUsableBy(row: { userId: string | null }, actingUserId: string | null | undefined): boolean {
  return row.userId === null || (Boolean(actingUserId) && row.userId === actingUserId)
}

/** A person's name as a sentence shows it, from whatever the user row has. */
export function credentialOwnerLabel(owner: { name?: string | null; email?: string | null } | null | undefined): string {
  return owner?.name?.trim() || owner?.email?.trim() || 'another member'
}

/** The plain-English refusal, naming the fix. `subject` is "This step" or the step's label. */
export function foreignHttpCredentialMessage(subject: string, ownerLabel: string, host: string): string {
  return `${subject} uses ${ownerLabel}'s personal credential for ${host}. Add your own credential for ${host}, or ask an admin to make it per-user.`
}
