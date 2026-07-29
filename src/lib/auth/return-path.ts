/** Accept only a same-origin absolute path. This value crosses the Google OAuth
 * round-trip AND rides in Location headers out of middleware, so protocol-relative
 * URLs, backslash variants, and control characters (which could split a header)
 * are all rejected. Surrounding whitespace is trimmed rather than rejected —
 * a copy-pasted link routinely carries it. */
export function validatedReturnPath(value: string | null | undefined): string | null {
  if (!value) return null
  const path = value.trim()
  if (!/^\/(?!\/)/.test(path)) return null
  if (path.includes('\\')) return null
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return null
  }
  return path
}
