/**
 * Which notifications a person can see, in one place.
 *
 * Two readers ask this — the bell's own endpoint and the app-shell snapshot —
 * and they must agree, or the badge counts rows the panel does not list.
 *
 * Clearing writes a watermark on the READER (`User.notificationsClearedAt`),
 * never on the notifications. A row is shared: `userId: null` means the whole
 * workspace sees it, so deleting on clear would empty a colleague's bell too.
 * A per-person stamp costs one nullable column and cannot reach anyone else's
 * view, and it keeps the rows themselves for anything that reads history.
 */

export type NotificationScope = {
  organizationId: string
  OR: ({ userId: string } | { userId: null })[]
  createdAt?: { gt: Date }
}

export function visibleNotificationScope(
  organizationId: string,
  userId: string,
  clearedAt: Date | null | undefined,
): NotificationScope {
  return {
    organizationId,
    OR: [{ userId }, { userId: null }],
    // Strictly after: a notification created in the same millisecond as the
    // clear is one the person was looking at when they pressed it.
    ...(clearedAt ? { createdAt: { gt: clearedAt } } : {}),
  }
}

/** The unread badge counts a subset of what the panel lists — never its own scope. */
export function unreadNotificationScope(
  organizationId: string,
  userId: string,
  clearedAt: Date | null | undefined,
): NotificationScope & { readAt: null } {
  return { ...visibleNotificationScope(organizationId, userId, clearedAt), readAt: null }
}
