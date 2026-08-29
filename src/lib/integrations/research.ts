/**
 * Web research integration — the external source the Market Research Brief
 * template describes and the platform did not have.
 *
 * Before this, an agent's only route to the open web was the generic `request`
 * tool, which needs a URL the model already knows. That is enough to read a
 * page and useless for research: "what has been announced about this account
 * this quarter" has no URL until something searches for it. The template
 * therefore produced a brief assembled entirely from Backstory's own CRM data
 * while claiming to carry "normalized external company-signal packets".
 *
 * Two tools, deliberately split:
 *  - `web_search` finds candidate sources and returns titles, URLs and the
 *    engine's own snippets.
 *  - `web_fetch` reads one of them as plain text.
 *
 * `web_fetch` exists next to the HTTP plane's `request` rather than reusing it
 * because the two answer different questions. `request` is for JSON APIs and
 * hands back a raw body; pointed at an article it spends most of a 50k budget
 * on markup and script tags. `web_fetch` strips a page to its readable text, so
 * a research run can afford to read several sources instead of one.
 *
 * Key resolution follows Granola exactly (see org-credential.ts): the
 * workspace's own saved key first, then the platform env value — and that only
 * for internal/partner orgs, because one search key is one billed account.
 *
 * Safety: every outbound call goes through fetchPublicUrl, so private and
 * internal addresses are refused, the validated address is pinned against DNS
 * rebinding, and redirects cannot walk the request somewhere the check never
 * saw. That matters more here than on most planes: `web_fetch` takes a URL the
 * model chose, and the model chose it from search results — attacker-authorable
 * content — which is the confused-deputy shape this codebase fences elsewhere.
 */

import type { ToolDefinition } from '@/lib/llm/model-runner'
import { fetchPublicUrl } from '@/lib/net/ssrf'
import { readResponseTextLimited } from '@/lib/net/response-body'
import { resolveOrgCredential, type CredentialSource } from './org-credential'

export const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

const SEARCH_TIMEOUT_MS = 15_000
const FETCH_TIMEOUT_MS = 20_000
/** Mirrors the HTTP tool's cap — one page must not be able to fill the window. */
const MAX_PAGE_BYTES = 50_000
const MAX_RESULTS = 20

export type ResolvedResearchKey = { apiKey: string; source: CredentialSource }

export async function getResearchApiKey(organizationId: string): Promise<ResolvedResearchKey | null> {
  const resolved = await resolveOrgCredential({
    organizationId,
    provider: 'research',
    envValue: process.env.BRAVE_SEARCH_API_KEY,
  })
  return resolved ? { apiKey: resolved.value, source: resolved.source } : null
}

export async function researchConfigured(organizationId: string): Promise<boolean> {
  return Boolean(await getResearchApiKey(organizationId))
}

/** Connection test: the cheapest query that still proves the key is accepted. */
export async function testResearchApiKey(apiKey: string): Promise<{ ok: boolean; status: number | null }> {
  try {
    const response = await fetch(`${BRAVE_SEARCH_ENDPOINT}?q=test&count=1`, {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    })
    return { ok: response.ok, status: response.status }
  } catch {
    return { ok: false, status: null }
  }
}

export function researchTools(): ToolDefinition[] {
  return [
    {
      name: 'web_search',
      description:
        'Search the open web and return ranked results with titles, URLs, publication dates and snippets. Use this to find external signals about a company — funding, leadership changes, product launches, analyst coverage, news — that the CRM cannot know. Follow up with web_fetch to read a result in full before citing it.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for, phrased as you would type it into a search engine.' },
          count: { type: 'number', description: `How many results to return (default 10, maximum ${MAX_RESULTS}).` },
          freshness: {
            type: 'string',
            enum: ['past_day', 'past_week', 'past_month', 'past_year'],
            description: 'Restrict results to recent material. Use this for anything time-sensitive — a weekly digest should not surface last year’s news as new.',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'web_fetch',
      description:
        'Read a web page as plain text, with its markup, scripts and navigation removed. Use this on a URL from web_search before quoting or summarising it — a search snippet is not enough to cite a claim from. Public web pages only.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute https URL of the page to read.' },
        },
        required: ['url'],
      },
    },
  ]
}

/** Brave's freshness codes. Spelled out in the schema so the model never guesses one. */
const FRESHNESS: Record<string, string> = {
  past_day: 'pd',
  past_week: 'pw',
  past_month: 'pm',
  past_year: 'py',
}

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
  /** The source's own published/updated date when the engine reports one. */
  age?: string
  siteName?: string
}

/**
 * Normalise one engine's payload into the shape the model reads.
 *
 * Pure and exported so the adapter can be replayed against a recorded response
 * without a key or a network — see src/lib/adapters.
 */
export function normalizeBraveResults(payload: unknown, limit: number): WebSearchResult[] {
  const results = (payload as { web?: { results?: unknown[] } })?.web?.results
  if (!Array.isArray(results)) return []
  return results.slice(0, limit).map((entry) => {
    const row = (entry ?? {}) as Record<string, unknown>
    const profile = (row.profile ?? {}) as Record<string, unknown>
    return {
      title: String(row.title ?? ''),
      url: String(row.url ?? ''),
      // Brave returns the snippet with <strong> around matched terms. Left in
      // it, the model reproduces the markup in prose it writes.
      snippet: stripTags(String(row.description ?? '')),
      ...(typeof row.age === 'string' && row.age ? { age: row.age } : {}),
      ...(typeof profile.name === 'string' && profile.name ? { siteName: profile.name } : {}),
    }
  })
}

/**
 * Reduce an HTML document to its readable text.
 *
 * Script and style bodies are removed FIRST, as whole elements. Stripping tags
 * alone would leave their contents behind, so a page's JavaScript would arrive
 * as prose — the single largest source of nonsense in a naive text extraction,
 * and on a modern page usually most of the bytes.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    // Block-level boundaries become newlines so paragraphs and list items do
    // not run together into one unreadable line.
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|br)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, '').trim()
}

/**
 * The guarded fetch this client makes every outbound call through. Injectable
 * for tests only — the default is the real SSRF-checked fetch, and no caller in
 * the runtime passes anything else. Mirrors the `proxy = defaultProxy()` seam
 * the Nango adapters use, so an adapter can be exercised without a network.
 */
export type GuardedFetch = typeof fetchPublicUrl

export class ResearchToolClient {
  constructor(
    private readonly apiKey: string,
    private readonly guardedFetch: GuardedFetch = fetchPublicUrl,
  ) {}

  async executeTool(_serverUrl: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === 'web_search') return this.search(args)
    if (name === 'web_fetch') return this.fetchPage(args)
    throw new Error(`Unknown research tool "${name}".`)
  }

  private async search(args: Record<string, unknown>): Promise<unknown> {
    const query = String(args.query ?? '').trim()
    if (!query) throw new Error('web_search needs a query.')
    const requested = Number(args.count)
    const count = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), MAX_RESULTS) : 10

    const url = new URL(BRAVE_SEARCH_ENDPOINT)
    url.searchParams.set('q', query)
    url.searchParams.set('count', String(count))
    const freshness = FRESHNESS[String(args.freshness ?? '')]
    if (freshness) url.searchParams.set('freshness', freshness)

    const response = await this.guardedFetch(
      url.toString(),
      {
        method: 'GET',
        headers: { Accept: 'application/json', 'X-Subscription-Token': this.apiKey },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      },
      // The search endpoint is a fixed, known host, so a redirect off it is
      // never legitimate — and following one would carry the subscription
      // token to wherever it pointed.
      { maxRedirects: 0 },
    )
    if (!response.ok) {
      const detail = await readResponseTextLimited(response, 2_000, 'Search response').catch(() => '')
      // 429 is the one a research run actually meets, and "rate limited" is
      // something the model can report honestly instead of retrying blindly.
      if (response.status === 429) throw new Error('The web search quota for this workspace is exhausted right now. Report what you have rather than retrying.')
      throw new Error(`Web search failed (${response.status}). ${detail.slice(0, 300)}`)
    }
    const payload = JSON.parse(await readResponseTextLimited(response, 200_000, 'Search response')) as unknown
    return { query, results: normalizeBraveResults(payload, count) }
  }

  private async fetchPage(args: Record<string, unknown>): Promise<unknown> {
    const url = String(args.url ?? '').trim()
    if (!url) throw new Error('web_fetch needs a url.')

    const response = await this.guardedFetch(url, {
      method: 'GET',
      // Some publishers serve a bare error page to an unidentified client.
      headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9', 'User-Agent': 'BackstoryStudio/1.0 (+research agent)' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    const contentType = response.headers.get('content-type') ?? ''
    const body = await readResponseTextLimited(response, MAX_PAGE_BYTES, 'Page')
    if (!response.ok) {
      return { url, status: response.status, error: `The page returned ${response.status}.`, text: '' }
    }
    const text = /html|xml/i.test(contentType) ? htmlToText(body) : body.trim()
    return {
      url: response.url || url,
      status: response.status,
      contentType,
      // Reported so the model can say "truncated" rather than treating a cut-off
      // page as the whole argument.
      truncated: body.length >= MAX_PAGE_BYTES,
      text,
    }
  }
}
