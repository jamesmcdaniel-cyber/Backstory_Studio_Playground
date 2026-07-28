/**
 * Detect data references this engine will never resolve.
 *
 * `resolveTemplate` only substitutes `{{path}}`. Any other placeholder syntax
 * survives resolution as literal text and is sent to the live API verbatim —
 * so a graph carrying `Bearer {Output}` or
 * `body('HTTP_action_—_get_OAuth_token')?['access_token']` posts that exact
 * string as its credential and comes back 401. The run then reports success
 * for every step while the request was never authenticated, which reads as a
 * server-side auth problem instead of the configuration error it is.
 *
 * Graphs authored by AI, or pasted from Power Automate / Logic Apps / Copilot
 * Studio, are the common source: those tools use `body('Step')?['field']`,
 * `outputs('Compose')`, `@{...}` and single-brace `{Output}` chips. The flow
 * builder's own data menu always emits `{{path}}`, so none of these can come
 * from picking a value in the UI.
 *
 * Patterns are deliberately narrow: each requires punctuation no ordinary
 * prose, JSON, or GraphQL body carries, so a legitimate payload is never
 * mistaken for a broken reference.
 */

/** `body('X')`, `outputs('X')`, `triggerBody()` — a call with a quoted or empty argument. */
const WDL_CALL_RE =
  /\b(?:body|outputs|item|items|actions|variables|parameters|trigger[A-Za-z]*)\s*\(\s*(?:'[^']*'|"[^"]*")?\s*\)/g

/** `?['access_token']` — the Logic Apps optional-property accessor. */
const WDL_ACCESSOR_RE = /\?\[\s*(?:'[^']*'|"[^"]*")\s*\]/g

/** `@{ ... }` — Logic Apps string interpolation. */
const AT_INTERPOLATION_RE = /@\{[^{}]*\}/g

/**
 * A lone `{Placeholder}` chip: one brace, a bare identifier-ish path, no
 * quotes or colons (which would make it JSON) — e.g. `{Output}`,
 * `{Output.body}`. Only ever applied to auth header values, where a brace is
 * unambiguous; a request body may legitimately contain `{ id }` (GraphQL).
 *
 * Deliberately NOT global: it is used with `.test()`, and a `g` regex carries
 * `lastIndex` between calls, so every other call would silently miss.
 */
const SINGLE_BRACE_RE = /\{\s*[A-Za-z_][A-Za-z0-9_ .\-\[\]]*\s*\}/

const FOREIGN_RES = [WDL_CALL_RE, WDL_ACCESSOR_RE, AT_INTERPOLATION_RE]

const AUTH_HEADER_RE = /^(authorization|proxy-authorization)$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/**
 * Collect the whole run of foreign syntax around a match so the error names
 * something the user can find in their step — `body('X')?['y']` rather than
 * two disconnected fragments.
 */
function foreignSpansIn(text: string): string[] {
  const spans: Array<[number, number]> = []
  for (const pattern of FOREIGN_RES) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0
      spans.push([start, start + match[0].length])
    }
  }
  if (!spans.length) return []
  spans.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = [spans[0]]
  for (const [start, end] of spans.slice(1)) {
    const last = merged[merged.length - 1]
    // Adjacent runs (`body('X')` immediately followed by `?['y']`) are one reference.
    if (start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged.map(([start, end]) => text.slice(start, end))
}

/**
 * Every foreign-tool data reference inside a resolved value, walking nested
 * objects and arrays. Empty means nothing suspicious was left behind.
 */
export function foreignReferences(value: unknown): string[] {
  if (typeof value === 'string') return foreignSpansIn(value)
  if (Array.isArray(value)) return value.flatMap((item) => foreignReferences(item))
  if (isRecord(value)) return Object.values(value).flatMap((item) => foreignReferences(item))
  return []
}

/**
 * Names of Authorization-style headers whose value still holds a placeholder
 * rather than a credential. A blank value is NOT reported: an empty auth
 * header is the credential-injection path's concern (it treats blank as
 * absent), not an unresolved reference.
 */
export function unresolvedAuthHeaders(headers: unknown): string[] {
  if (typeof headers === 'string') {
    try {
      const parsed: unknown = JSON.parse(headers)
      return isRecord(parsed) ? unresolvedAuthHeaders(parsed) : []
    } catch {
      return []
    }
  }
  if (!isRecord(headers)) return []
  return Object.entries(headers)
    .filter(([key, value]) => {
      if (!AUTH_HEADER_RE.test(key.trim()) || typeof value !== 'string' || !value.trim()) return false
      return foreignSpansIn(value).length > 0 || SINGLE_BRACE_RE.test(value)
    })
    .map(([key]) => key)
}

const quoteList = (items: string[]): string => items.map((item) => `"${item}"`).join(', ')

/** Plain-English failure for a value still carrying another tool's syntax. */
export function foreignReferenceMessage(references: string[]): string {
  return `This step references data the way another automation tool writes it — ${quoteList(references)}. This flow can't read that, and would have sent it as literal text. Open the step's settings and pick the value from the data menu instead.`
}

/** Plain-English failure for an auth header that never got a real credential. */
export function unresolvedAuthMessage(headerNames: string[]): string {
  return `The ${quoteList(headerNames)} header is still a placeholder, not a credential — the request would have been sent unauthenticated and rejected. Open the step's settings and pick the token from the data menu, or choose a saved credential under Authentication.`
}
