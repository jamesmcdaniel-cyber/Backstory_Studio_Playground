import { cached } from '@/lib/cache'

/**
 * Retrieval over the public Backstory help centre (help.backstory.ai, an
 * Intercom site), so the Assistant can answer product questions — "what is
 * Backstory MCP", "how do I connect Salesforce", "what does activity capture
 * do" — from the documentation instead of from the model's own recollection.
 *
 * Deliberately dependency-free: Intercom serves server-rendered HTML, so a
 * search hits one URL and an article one more. Everything here is best-effort —
 * the help centre being slow or down must degrade the answer, never break it —
 * and read-through cached, so a warm instance answers repeat questions without
 * any outbound request.
 */

const ORIGIN = 'https://help.backstory.ai'
const SEARCH_TIMEOUT_MS = 4_000
const ARTICLE_TIMEOUT_MS = 5_000
/** Docs change rarely; an hour keeps them fresh without re-fetching per question. */
const TTL_MS = 60 * 60 * 1000
/** Per-article budget fed to the model — enough for a full how-to, bounded for tokens. */
const MAX_ARTICLE_CHARS = 3_000

export type HelpArticle = {
  title: string
  url: string
  /** Search-result preview; empty when the article was fetched directly. */
  snippet: string
}

export type HelpDoc = HelpArticle & {
  /** Extracted article body, capped at MAX_ARTICLE_CHARS. */
  text: string
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
}

/** Decode the entity subset Intercom emits (no DOM available server-side). */
export function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
}

/** Strip tags to readable text, keeping block boundaries as line breaks. */
function toText(html: string): string {
  const text = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  return decodeEntities(text)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Pull the article cards out of a help-centre search page.
 *
 * Intercom wraps each hit in an anchor to `/en/articles/<slug>` holding the
 * title and a preview, with the matched words split into their own <span>s for
 * highlighting — so both parts are read by stripping tags rather than by
 * matching text directly.
 */
export function parseSearchResults(html: string): HelpArticle[] {
  const out: HelpArticle[] = []
  const seen = new Set<string>()
  const anchor = /<a\b[^>]*href="(\/en\/articles\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi
  for (const match of html.matchAll(anchor)) {
    const path = match[1]
    if (seen.has(path)) continue
    const inner = match[2]
    // The preview block, when present, splits the card into title and snippet.
    // The class match lands INSIDE the opening tag, so back up to its `<` —
    // slicing mid-tag would leave the attribute text in the snippet.
    const previewAt = inner.search(/class="[^"]*paper__preview/i)
    const split = previewAt > 0 ? inner.lastIndexOf('<', previewAt) : -1
    const title = toText(split > 0 ? inner.slice(0, split) : inner).split('\n')[0].trim()
    if (!title) continue
    seen.add(path)
    out.push({
      title,
      url: `${ORIGIN}${path}`,
      snippet: split > 0 ? toText(inner.slice(split)).replace(/\s+/g, ' ').trim() : '',
    })
  }
  return out
}

/**
 * Extract an article's readable body.
 *
 * Bounded by the two markers Intercom always renders: the `article` container
 * that opens the content and the "Did this answer your question?" reaction
 * footer that closes it. If either is missing the whole page is stripped
 * instead — worse text, still text.
 */
export function extractArticleText(html: string): string {
  const start = html.search(/<div[^>]*class="[^"]*\barticle\b[^"]*"/i)
  const end = html.indexOf('Did this answer your question')
  const body = html.slice(start > 0 ? start : 0, end > start ? end : html.length)
  const text = toText(body)
    // Intercom's byline and in-page nav carry no answer content.
    .replace(/^\s*Updated (over )?[a-z0-9 ]+ago\s*$/gim, '')
    .replace(/^\s*Table of contents\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text.length > MAX_ARTICLE_CHARS ? `${text.slice(0, MAX_ARTICLE_CHARS).trimEnd()}…` : text
}

async function getText(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { accept: 'text/html', 'user-agent': 'BackstoryStudio/1.0 (help-center reader)' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.ok ? await response.text() : null
  } catch {
    return null // offline, timed out, blocked — the caller degrades to no docs
  }
}

/** Search the help centre. Best-effort: returns [] on any failure. */
export async function searchHelpCenter(query: string, limit = 4): Promise<HelpArticle[]> {
  const q = query.trim().slice(0, 200)
  if (!q) return []
  const results = await cached(`helpcenter:search:${q.toLowerCase()}`, TTL_MS, async () => {
    const html = await getText(`${ORIGIN}/en/?q=${encodeURIComponent(q)}`, SEARCH_TIMEOUT_MS)
    return html ? parseSearchResults(html) : []
  })
  return results.slice(0, limit)
}

/** Fetch and extract one article. Best-effort: returns null on any failure. */
export async function fetchHelpArticle(article: HelpArticle): Promise<HelpDoc | null> {
  if (!article.url.startsWith(`${ORIGIN}/`)) return null // never follow off-site links
  const text = await cached(`helpcenter:article:${article.url}`, TTL_MS, async () => {
    const html = await getText(article.url, ARTICLE_TIMEOUT_MS)
    return html ? extractArticleText(html) : ''
  })
  return text ? { ...article, text } : null
}

/**
 * The help-centre passages that bear on a question: search, then read the top
 * `depth` articles in full. Never throws and never rejects — a question the
 * docs don't cover simply yields [].
 */
export async function retrieveHelpDocs(question: string, depth = 2): Promise<HelpDoc[]> {
  try {
    const hits = await searchHelpCenter(question)
    if (!hits.length) return []
    const docs = await Promise.all(hits.slice(0, depth).map(fetchHelpArticle))
    return docs.filter((doc): doc is HelpDoc => doc !== null)
  } catch {
    return []
  }
}
