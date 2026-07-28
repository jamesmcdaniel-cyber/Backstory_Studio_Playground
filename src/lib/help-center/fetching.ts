/**
 * Shared primitives for reading the public sources the Assistant answers from.
 *
 * Three sites carry the product's public knowledge and none of them is this
 * codebase: the help centre (help.backstory.ai), the developer docs
 * (backstory-studio.mintlify.site) and the automation library
 * (backstory-workflows.vercel.app). They are all read the same way — one
 * outbound GET, a hard timeout, read-through cache — so the fetching, the
 * HTML-to-text stripping and the term scoring live here rather than three times
 * over.
 *
 * Everything is BEST-EFFORT: a source being slow, moved, or down must cost the
 * answer detail, never break it. Every function here returns empty rather than
 * throwing.
 */

/** Sources change on a docs-release cadence; an hour is fresh enough and keeps warm instances off the network. */
export const TTL_MS = 60 * 60 * 1000

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
}

/** Decode the entity subset these sites emit (no DOM available server-side). */
export function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
}

/** Strip tags to readable text, keeping block boundaries as line breaks. */
export function toText(html: string): string {
  const text = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  return decodeEntities(text)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Truncate to a budget on a whole character, marking that it was cut. */
export function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
}

const USER_AGENT = 'BackstoryStudio/1.0 (assistant knowledge reader)'

/** GET a document as text. Best-effort: null on non-2xx, timeout, or network error. */
export async function getText(url: string, timeoutMs: number, accept = 'text/html'): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { accept, 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.ok ? await response.text() : null
  } catch {
    return null // offline, timed out, blocked — the caller degrades to no docs
  }
}

/** GET and parse JSON. Best-effort: null on any failure, including malformed bodies. */
export async function getJson<T>(url: string, timeoutMs: number): Promise<T | null> {
  const body = await getText(url, timeoutMs, 'application/json')
  if (!body) return null
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'how', 'can', 'what', 'you', 'your', 'are', 'this', 'that', 'from', 'about',
  'into', 'does', 'should', 'could', 'would', 'when', 'where', 'which', 'our', 'get', 'use', 'using', 'need',
  'want', 'there', 'have', 'has', 'was', 'were', 'why', 'who', 'any', 'all', 'not', 'but', 'its',
])

/** The words in a question worth matching a source against. */
export function questionTerms(question: string): string[] {
  return [...new Set(
    question.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  )]
}

/**
 * A term matches when it appears in the text, or when its singular does — so
 * "workflows" finds "workflow" and "briefs" finds "Meeting Brief". Deliberately
 * cruder than a stemmer: it only ranks short titles and summaries, and a wrong
 * stem costs relevance the model then has to see past.
 */
export function termMatches(term: string, haystack: string): boolean {
  if (haystack.includes(term)) return true
  return term.length > 3 && term.endsWith('s') && haystack.includes(term.slice(0, -1))
}

/** How many of a question's terms appear in a haystack (already lower-cased). */
export function termHits(terms: string[], haystack: string): number {
  return terms.filter((term) => termMatches(term, haystack)).length
}
