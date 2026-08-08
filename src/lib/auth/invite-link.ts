import { validatedReturnPath } from './return-path'

export function invitationMatchesIdentity(invitedEmail: string, verifiedEmail: string | null | undefined): boolean {
  const invited = invitedEmail.trim().toLowerCase()
  const verified = verifiedEmail?.trim().toLowerCase()
  return Boolean(invited && verified && invited === verified)
}

/** The invitation acceptance URL. `next` (validated same-origin) is where
 *  acceptance lands the recipient — an invite sent from a jam points at that
 *  flow, so joining a workspace and arriving where you were invited is one
 *  continuous motion instead of a bounce to the dashboard. */
export function buildInviteLink(base: string, token: string, next?: string | null): string {
  const origin = base.replace(/\/$/, '')
  const destination = validatedReturnPath(next)
  const query = destination ? `?next=${encodeURIComponent(destination)}` : ''
  return `${origin}/invite/${token}${query}`
}
