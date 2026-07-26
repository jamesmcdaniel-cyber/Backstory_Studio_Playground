/** Accept only a same-origin absolute path. This value crosses the Google OAuth
 * round-trip, so protocol-relative URLs and backslash variants are rejected. */
export function validatedReturnPath(value: string | null | undefined): string | null {
  return value && /^\/(?!\/)/.test(value) && !value.includes('\\') ? value : null
}
