import { retrieveLibraryDocs } from '@/lib/help-center/automation-library'
import { retrieveDevDocs } from '@/lib/help-center/dev-docs'
import { retrieveHelpDocs } from '@/lib/help-center/docs'

/**
 * The Assistant's public-knowledge retrieval: one question in, a ranked set of
 * citable passages out, drawn from all three sites that document Backstory.
 *
 *   help.backstory.ai              what the product does and how to set it up
 *   backstory-studio.mintlify.site the API and MCP reference — what you can call
 *   backstory-workflows.vercel.app the automation library — what is already built
 *
 * They answer different halves of most questions ("what can I do with Backstory
 * MCP" is a product answer, a tool list, and a catalogue of ready-made agents),
 * so they are fetched together and interleaved rather than tried in order.
 *
 * Best-effort throughout: each source degrades to nothing on its own, and a
 * question none of them covers simply yields [] and an unsourced answer.
 */

export type KnowledgeSource = 'help' | 'developer' | 'library'

export type KnowledgeDoc = {
  source: KnowledgeSource
  title: string
  /** Direct, human-followable URL — this is what a citation links to. */
  url: string
  /** Passage handed to the model. */
  text: string
}

/** How a source is named to the user, in a citation and in the prompt. */
export const SOURCE_LABEL: Record<KnowledgeSource, string> = {
  help: 'Backstory Help Centre',
  developer: 'Backstory Developer Docs',
  library: 'Backstory Automation Library',
}

/** Total passages fed to one answer — enough to be specific, bounded for tokens and latency. */
const MAX_DOCS = 6

/**
 * How long the whole retrieval may take before the answer is written without
 * whatever has not arrived.
 *
 * Warm, all three sources answer together in well under a second; the tail is a
 * cold instance paying DNS and TLS on three hosts at once. This bounds that tail
 * for the user, and the slow fetch still finishes into the cache for the next
 * question, so a source lost here is lost once.
 */
const BUDGET_MS = 8_000

/** Resolve to `fallback` if `work` has not finished within the budget. Never rejects. */
async function withDeadline<T>(work: Promise<T>, fallback: T, ms = BUDGET_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms) })
  try {
    return await Promise.race([work.catch(() => fallback), deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Take from each source in turn until the budget is spent, so the one source
 * that happens to match a question five ways cannot crowd out the two that
 * matched it once each.
 */
export function interleave(groups: KnowledgeDoc[][], limit = MAX_DOCS): KnowledgeDoc[] {
  const out: KnowledgeDoc[] = []
  const seen = new Set<string>()
  const depth = Math.max(0, ...groups.map((group) => group.length))
  for (let i = 0; i < depth && out.length < limit; i += 1) {
    for (const group of groups) {
      const doc = group[i]
      if (!doc || out.length >= limit) continue
      const key = `${doc.source}|${doc.title.trim().toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(doc)
    }
  }
  return out
}

/**
 * Everything the public sources say about a question. Runs the three retrievals
 * concurrently — the slowest source sets the latency, not their sum — and never
 * rejects.
 */
export async function retrieveKnowledge(question: string, limit = MAX_DOCS): Promise<KnowledgeDoc[]> {
  const [help, developer, library] = await Promise.all([
    withDeadline(retrieveHelpDocs(question), []),
    withDeadline(retrieveDevDocs(question), []),
    withDeadline(retrieveLibraryDocs(question), []),
  ])
  return interleave([
    help.map((doc): KnowledgeDoc => ({ source: 'help', title: doc.title, url: doc.url, text: doc.text })),
    developer.map((doc): KnowledgeDoc => ({ source: 'developer', title: doc.title, url: doc.url, text: doc.text })),
    library.map((doc): KnowledgeDoc => ({ source: 'library', title: doc.title, url: doc.url, text: doc.text })),
  ], limit)
}
