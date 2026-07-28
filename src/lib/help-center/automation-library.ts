import { cached } from '@/lib/cache'
import { cap, getJson, questionTerms, termHits, TTL_MS } from '@/lib/help-center/fetching'

/**
 * Retrieval over the public Backstory Automation Library
 * (backstory-workflows.vercel.app) — the catalogue of ready-made automation
 * workflows and LLM skills built on Backstory MCP.
 *
 * This is the source that answers "what can I actually build with this": the
 * help centre explains the product and the developer docs list the endpoints,
 * but the library is the only place that says a Sales Digest workflow exists,
 * what it triggers on, and which MCP tools an Account Plan Agent calls.
 *
 * The site is a client-rendered SPA, so its HTML carries nothing. It does
 * publish the two catalogues it renders from — `/workflows.json` and
 * `/skills.json` — which is what is read here. They are large (about 1 MB
 * together) and mostly platform payloads the Assistant never needs, so the
 * cached artefact is a distilled index: one short, self-contained summary per
 * entry, ~80 KB for the whole catalogue.
 */

const ORIGIN = 'https://backstory-workflows.vercel.app'
const CATALOGUE_TIMEOUT_MS = 6_000
/** Per-entry budget fed to the model — a full step list for a workflow, bounded for tokens. */
const MAX_ENTRY_CHARS = 1_400
/** Share of the question's terms an entry must cover (matches the other sources' floor). */
const MIN_SCORE = 0.5

export type LibraryKind = 'workflow' | 'skill'

export type LibraryEntry = {
  id: string
  kind: LibraryKind
  name: string
  category: string
  /** Self-contained summary handed to the model. */
  text: string
}

export type LibraryDoc = LibraryEntry & { title: string; url: string }

/**
 * Every library entry cites the site root.
 *
 * The catalogue does have per-entry routes (`/workflow/:id`, `/skills/:id`) but
 * the deployment ships no SPA rewrite, so those paths 404 for anyone following
 * the link. A citation that 404s is worse than a coarse one, so the URL points
 * at the library and the citation title names the exact entry. Once the library
 * deployment serves its deep links, this becomes a per-entry path.
 */
function entryUrl(): string {
  return `${ORIGIN}/`
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(str).filter(Boolean) : []

function join(parts: (string | false | 0 | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join('\n')
}

type RawSteps = { step?: unknown; stepNum?: unknown; name?: unknown; description?: unknown }[]

/** Flatten a step list to one line: "1. Fetch users — reads the subscriber list". */
function steps(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return (value as RawSteps)
    .map((step) => {
      const n = step.step ?? step.stepNum
      const name = str(step.name)
      const description = str(step.description)
      if (!name) return ''
      return `${typeof n === 'number' ? `${n}. ` : ''}${name}${description ? ` — ${description}` : ''}`
    })
    .filter(Boolean)
    .join(' ')
}

/** One workflow → one prompt-ready summary. Unknown fields are skipped, never guessed. */
export function distillWorkflow(raw: Record<string, unknown>): LibraryEntry | null {
  const id = str(raw.id)
  const name = str(raw.name)
  if (!id || !name) return null
  const category = str(raw.category)
  const credentials = list(raw.credentials)
  const flow = steps(raw.node_flow)
  // The catalogue's trigger strings carry table pipes from the source Markdown.
  const trigger = str(raw.trigger).replace(/[|\s]+$/, '')
  return {
    id,
    kind: 'workflow',
    name,
    category,
    text: cap(join([
      `${name} — automation workflow${category ? ` (${category})` : ''}`,
      str(raw.description),
      trigger && `Trigger: ${trigger}`,
      str(raw.output) && `Delivers to: ${str(raw.output)}`,
      credentials.length > 0 && `Needs: ${credentials.join('; ')}`,
      flow && `Steps: ${flow}`,
    ]), MAX_ENTRY_CHARS),
  }
}

/** One skill → one prompt-ready summary. */
export function distillSkill(raw: Record<string, unknown>): LibraryEntry | null {
  const id = str(raw.id)
  const name = str(raw.name)
  if (!id || !name) return null
  const category = str(raw.category)
  const audience = list(raw.audience)
  const tools = list(raw.mcpTools)
  const platforms = raw.platforms && typeof raw.platforms === 'object' ? Object.keys(raw.platforms) : []
  const walkthrough = steps((raw.walkthrough as { steps?: unknown } | undefined)?.steps)
  return {
    id,
    kind: 'skill',
    name,
    category,
    text: cap(join([
      `${name} — LLM skill${category ? ` (${category})` : ''}`,
      str(raw.description),
      str(raw.input) && `Input: ${str(raw.input)}`,
      audience.length > 0 && `Built for: ${audience.join(', ')}`,
      tools.length > 0 && `Backstory MCP tools it calls: ${tools.join(', ')}`,
      platforms.length > 0 && `Runs on: ${platforms.join(', ')}`,
      walkthrough && `How it runs: ${walkthrough}`,
    ]), MAX_ENTRY_CHARS),
  }
}

function entries(payload: unknown, key: string): Record<string, unknown>[] {
  const root = payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : null
  return Array.isArray(root) ? (root.filter((row) => row && typeof row === 'object') as Record<string, unknown>[]) : []
}

/** The distilled catalogue: every workflow and skill, summarised. Best-effort: [] when unreachable. */
export async function fetchLibraryIndex(): Promise<LibraryEntry[]> {
  return cached('library:index', TTL_MS, async () => {
    const [workflows, skills] = await Promise.all([
      getJson<unknown>(`${ORIGIN}/workflows.json`, CATALOGUE_TIMEOUT_MS),
      getJson<unknown>(`${ORIGIN}/skills.json`, CATALOGUE_TIMEOUT_MS),
    ])
    return [
      ...entries(workflows, 'workflows').map(distillWorkflow),
      ...entries(skills, 'skills').map(distillSkill),
    ].filter((entry): entry is LibraryEntry => entry !== null)
  })
}

/**
 * Rank catalogue entries against a question's terms — name weighted double, on
 * the same share-of-terms floor as the other sources, so "how do I invite a
 * teammate" ranks nothing here rather than the least-unrelated workflow.
 */
export function rankLibrary(terms: string[], catalogue: LibraryEntry[], limit = 3): LibraryEntry[] {
  if (!terms.length) return []
  return catalogue
    .map((entry, index) => {
      const name = entry.name.toLowerCase()
      const rest = `${entry.category} ${entry.text}`.toLowerCase()
      const covered = termHits(terms, `${name} ${rest}`)
      return { entry, index, covered, score: termHits(terms, name) * 2 + termHits(terms, rest) }
    })
    .filter((row) => row.covered / terms.length >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((row) => row.entry)
}

/**
 * The library entries that bear on a question. Never throws — a question the
 * catalogue does not cover simply yields [].
 */
export async function retrieveLibraryDocs(question: string, depth = 3): Promise<LibraryDoc[]> {
  try {
    const ranked = rankLibrary(questionTerms(question), await fetchLibraryIndex(), depth)
    return ranked.map((entry) => ({ ...entry, title: entry.name, url: entryUrl() }))
  } catch {
    return []
  }
}
