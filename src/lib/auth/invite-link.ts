import { validatedReturnPath } from './return-path'

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
