/**
 * Every persisted trace artifact (errors, logs, HTTP bodies, tool outputs) is
 * bounded before it hits the database — but a silent `.slice()` makes a
 * truncated value indistinguishable from a short one that just happens to end
 * at the cutoff. These helpers make the cut explicit so a reader (or a
 * downstream consumer) can tell truncation happened and by how much.
 */

/** `text` unchanged when within `max`; otherwise sliced to `max` with an
 *  explicit marker naming exactly how many characters were dropped. */
export function truncateWithMarker(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/** Stringify an unknown error value (Error, string, or object) and apply the
 *  same explicit-truncation marker, defaulting to the 300-char error budget. */
export function truncateError(err: unknown, max = 300): string {
  return truncateWithMarker(stringifyError(err), max)
}
