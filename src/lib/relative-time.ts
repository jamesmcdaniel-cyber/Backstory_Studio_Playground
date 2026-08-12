/**
 * Compact relative time — "just now", "5m ago", "2h ago", "3d ago" — falling
 * back to an absolute date once something is a week old, where "9d ago" stops
 * being more useful than the date itself.
 *
 * Unparseable or future timestamps read as "just now" rather than rendering
 * "NaNm ago" or a negative age.
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return 'just now'

  const seconds = Math.floor((now.getTime() - then) / 1000)
  if (seconds < 60) return 'just now'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`

  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
