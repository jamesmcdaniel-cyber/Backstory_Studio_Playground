/**
 * MCP server-URL comparison, with no imports.
 *
 * This lived in backstory-connection.ts, which imports prisma — so the moment a
 * CLIENT component needed it, webpack followed prisma into cache.ts, into
 * ioredis, and into `dns`/`net`/`tls`, which do not exist in a browser bundle.
 * The build failed on modules nothing in the browser was ever going to call.
 *
 * A leaf module is the fix: three lines of string comparison that both the
 * server code and the builder can share without either dragging the other's
 * dependencies along.
 */

/** Loose server-URL equality: case-insensitive, ignores trailing slashes. */
export function sameServerUrl(a: string, b: string): boolean {
  const norm = (value: string) => value.trim().replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b) && norm(a).length > 0
}
