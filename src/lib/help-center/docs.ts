import { cached } from '@/lib/cache'
import { cap, decodeEntities, getText, questionTerms, TTL_MS, toText } from '@/lib/help-center/fetching'

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
 *
 * This is one of three public sources; see `retrieve.ts` for the other two and
 * for how they are merged into a single ranked citation list.
 */

const ORIGIN = 'https://help.backstory.ai'
const SEARCH_TIMEOUT_MS = 4_000
const ARTICLE_TIMEOUT_MS = 5_000
/** Per-article budget fed to the model — enough for a full how-to, bounded for tokens. */
const MAX_ARTICLE_CHARS = 3_000
/**
 * Share of a question's meaningful words an article must contain to be used.
 *
 * Measured against the live help centre: questions it genuinely covers score
 * 1.0 at the top hit ("what is activity capture", "how do I connect
 * Salesforce", "how does forecasting work"), while nonsense strings score 0.20
 * and off-topic ones ("what is the weather in Tokyo") score 0.00–0.33 — Intercom
 * returns a few articles for anything. Half the words is the clean separator.
 */
const MIN_HIT_SCORE = 0.5

export { decodeEntities, questionTerms }

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
  return cap(text, MAX_ARTICLE_CHARS)
}

/**
 * Share of the question's terms that appear in a hit's title or preview.
 *
 * Intercom's search is fuzzy enough to return a couple of articles for almost
 * any string — including nonsense — so a hit that shares no vocabulary with the
 * question is dropped before it costs an article fetch and a slice of prompt.
 * Exact containment on purpose: the 0.5 floor below is calibrated against it.
 */
export function hitScore(terms: string[], hit: HelpArticle): number {
  if (!terms.length) return 0
  const haystack = `${hit.title} ${hit.snippet}`.toLowerCase()
  return terms.filter((term) => haystack.includes(term)).length / terms.length
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
    const terms = questionTerms(question)
    const hits = (await searchHelpCenter(question)).filter((hit) => hitScore(terms, hit) >= MIN_HIT_SCORE)
    if (!hits.length) return []
    const docs = await Promise.all(hits.slice(0, depth).map(fetchHelpArticle))
    return docs.filter((doc): doc is HelpDoc => doc !== null)
  } catch {
    return []
  }
}
