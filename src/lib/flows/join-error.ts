/**
 * What to show when opening a flow failed. The API returns SHARE_LINK_INVALID
 * only when the caller PRESENTED a share token — they already hold one, so
 * naming the link leaks nothing new and is the only way a rotated link is
 * comprehensible. For everyone else a missing and an inaccessible flow stay
 * indistinguishable, and this copy keeps them that way.
 *
 * "Signed in as the wrong account" is the other common join failure (a personal
 * Google account instead of the work one an invite went to), so the account is
 * named whenever we know it and switching is offered.
 */
export function joinErrorMessage(
  code: string | null,
  signedInAs: string | null,
): { title: string; body: string; canSwitchAccount: boolean } {
  if (code === 'SHARE_LINK_INVALID') {
    return {
      title: 'This share link is no longer valid',
      body: signedInAs
        ? `The link was turned off or rotated. Ask whoever shared it for a new one — you’re signed in as ${signedInAs}.`
        : 'The link was turned off or rotated. Ask whoever shared it for a new one.',
      canSwitchAccount: Boolean(signedInAs),
    }
  }
  if (code === 'NOT_FOUND') {
    return {
      title: 'We couldn’t open this flow',
      body: signedInAs
        ? `It may have been deleted, or this account doesn’t have access — you’re signed in as ${signedInAs}.`
        : 'It may have been deleted, or this account doesn’t have access.',
      canSwitchAccount: Boolean(signedInAs),
    }
  }
  return {
    title: 'We couldn’t open this flow',
    body: 'Something went wrong loading it. Check your connection and try again.',
    canSwitchAccount: false,
  }
}
