import { cached } from '@/lib/cache'
import { cap, getText, questionTerms, termHits, TTL_MS } from '@/lib/help-center/fetching'

/**
 * Retrieval over the public Backstory developer documentation
 * (backstory-studio.mintlify.site) — the API reference, the MCP essentials and
 * the recipes.
 *
 * Where the help centre answers "what does this product do", these docs answer
 * "what can I actually call, and how" — which tools the Backstory MCP exposes,
 * which endpoints exist, how authentication works. Questions like "what can I
 * do with Backstory MCP" are only half-answered without them.
 *
 * Mintlify publishes two things that make this cheap and exact, so no crawling
 * or HTML scraping is involved:
 *   - `/llms.txt` — every page as `- [Title](url.md): description`, one file.
 *   - `<page>.md` — the raw Markdown of any page, which is what the model wants
 *     anyway.
 * Best-effort and read-through cached, like every source here.
 */

/** The host the user browses. `llms.txt` emits `.mintlify.app` URLs for the same pages; paths are rebuilt against this. */
const ORIGIN = 'https://backstory-studio.mintlify.site'
// Two sequential hops (index, then page), so each is generous — the overall
// budget in retrieve.ts is what actually bounds them. A tighter index timeout
// lost the developer docs entirely on a cold instance, where DNS and TLS are
// slowest and the other two sources are saturating the same connection.
const INDEX_TIMEOUT_MS = 6_000
const PAGE_TIMEOUT_MS = 6_000
/** Per-page budget fed to the model. API pages are dense, so a little tighter than a help article. */
const MAX_PAGE_CHARS = 2_600
/** Share of the question's terms a page must cover to be worth a fetch (matches the help-centre floor). */
const MIN_SCORE = 0.5

export type DevDocEntry = {
  title: string
  /** Human-facing page URL — what a citation links to. */
  url: string
  /** Raw-Markdown URL for the same page (the `.md` twin). */
  markdownUrl: string
  description: string
}

export type DevDoc = DevDocEntry & { text: string }

/**
 * Parse Mintlify's `llms.txt` index.
 *
 * Each documented page is one list item: `- [Title](https://host/path.md)`,
 * optionally followed by `: description`. Non-page assets (the OpenAPI specs
 * Mintlify also lists) are skipped — they are megabytes of YAML and answer
 * nothing a page does not.
 */
export function parseDocIndex(text: string): DevDocEntry[] {
  const out: DevDocEntry[] = []
  const seen = new Set<string>()
  const line = /^-\s*\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)\s*(?::\s*(.*))?$/gm
  for (const match of text.matchAll(line)) {
    const [, title, href, description] = match
    let path: string
    try {
      path = new URL(href).pathname
    } catch {
      continue
    }
    if (!path.endsWith('.md')) continue // OpenAPI YAML and other assets
    const page = path.slice(0, -'.md'.length)
    if (seen.has(page)) continue
    seen.add(page)
    out.push({
      title: title.trim(),
      url: `${ORIGIN}${page}`,
      markdownUrl: `${ORIGIN}${path}`,
      description: (description ?? '').trim(),
    })
  }
  return out
}

/**
 * Strip the navigation preamble Mintlify prepends to every raw page.
 *
 * It is a blockquote pointing back at `llms.txt` — useful to a crawler,
 * noise in a prompt. Only removed when it is that preamble, so a page opening
 * on a real blockquote keeps it.
 */
export function stripIndexPreamble(markdown: string): string {
  const body = markdown.replace(/^(?:>[^\n]*\n?)+\n*/, (block) =>
    /documentation index/i.test(block) ? '' : block)
  return body.trim()
}

/** The index of every documented page. Best-effort: [] when the docs are unreachable. */
export async function fetchDocIndex(): Promise<DevDocEntry[]> {
  return cached('devdocs:index', TTL_MS, async () => {
    const text = await getText(`${ORIGIN}/llms.txt`, INDEX_TIMEOUT_MS, 'text/plain')
    return text ? parseDocIndex(text) : []
  })
}

/**
 * Rank index entries against a question's terms.
 *
 * A hit in the title counts double: the index carries one line per page, so a
 * term landing in "Backstory MCP" is far stronger evidence than the same term
 * appearing somewhere in a paragraph of description. The floor is a share of
 * the question's terms — the same shape the help centre uses — so an unrelated
 * question ranks nothing rather than the least-bad page.
 */
export function rankDocIndex(terms: string[], entries: DevDocEntry[], limit = 2): DevDocEntry[] {
  if (!terms.length) return []
  return entries
    .map((entry, index) => {
      const title = entry.title.toLowerCase()
      const rest = `${entry.description} ${entry.url}`.toLowerCase()
      const covered = termHits(terms, `${title} ${rest}`)
      return { entry, index, covered, score: termHits(terms, title) * 2 + termHits(terms, rest) }
    })
    .filter((row) => row.covered / terms.length >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((row) => row.entry)
}

/** Fetch one page as raw Markdown. Best-effort: null on any failure. */
export async function fetchDevDoc(entry: DevDocEntry): Promise<DevDoc | null> {
  if (!entry.markdownUrl.startsWith(`${ORIGIN}/`)) return null // never follow off-site links
  const text = await cached(`devdocs:page:${entry.markdownUrl}`, TTL_MS, async () => {
    const markdown = await getText(entry.markdownUrl, PAGE_TIMEOUT_MS, 'text/plain')
    return markdown ? cap(stripIndexPreamble(markdown), MAX_PAGE_CHARS) : ''
  })
  return text ? { ...entry, text } : null
}

/**
 * The developer-doc pages that bear on a question. Never throws — a question
 * the API docs do not cover simply yields [].
 */
export async function retrieveDevDocs(question: string, depth = 2): Promise<DevDoc[]> {
  try {
    const entries = rankDocIndex(questionTerms(question), await fetchDocIndex(), depth)
    if (!entries.length) return []
    const docs = await Promise.all(entries.map(fetchDevDoc))
    return docs.filter((doc): doc is DevDoc => doc !== null)
  } catch {
    return []
  }
}
