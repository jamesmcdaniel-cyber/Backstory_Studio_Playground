/**
 * Sanitizer for the AI-generated agent role label ("Deal Researcher",
 * "Pipeline Reporter"). The model is asked for 1–2 words, but models drift —
 * quotes, trailing periods, whole sentences — and the label renders inside a
 * small card chip, so anything that survives this function must be short and
 * clean or the chip is simply omitted.
 */

const MAX_LABEL_LENGTH = 26

/** Clamp a raw model answer to a displayable 1–2 word Title Case label, or null. */
export function sanitizeRoleLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const words = raw
    .replace(/["'“”‘’.()[\]{}]/g, ' ')
    .split(/[\s/]+/)
    .map((word) => word.replace(/[^\p{L}\p{N}&-]/gu, ''))
    .filter((word) => /\p{L}/u.test(word))
    .slice(0, 2)
    .map((word) => word.charAt(0).toLocaleUpperCase() + word.slice(1))
  if (!words.length) return null
  const label = words.join(' ')
  return label.length <= MAX_LABEL_LENGTH ? label : null
}
