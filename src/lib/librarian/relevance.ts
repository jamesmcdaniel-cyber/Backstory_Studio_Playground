/**
 * Deciding which library items an Assistant answer should actually link to.
 *
 * The candidate list behind an answer is a keyword match, so it routinely
 * contains the same agent three times and four runs of it — and items that have
 * nothing to do with the question. The model marks the ones it genuinely used;
 * these helpers collapse the duplicates and read that mark back. Kept out of the
 * route so they are unit-testable without the model client or Prisma.
 */

export type LibrarianResult = {
  /** `doc` is a help-centre article (an external link); the rest are workspace items. */
  type: 'agent' | 'flow' | 'template' | 'run' | 'doc'
  id: string
  title: string
  subtitle: string
  href: string
}

/**
 * Splits the model's trailing `RELEVANT: 1, 3` line off the answer and returns
 * the 1-based candidate numbers it named.
 *
 * A missing or unparsable line yields no picks on purpose: over-linking — every
 * answer trailed by a wall of loosely-related agents — is the failure mode this
 * exists to prevent, so silence means "link nothing".
 */
export function parseRelevance(text: string, candidateCount: number): { answer: string; picked: number[] } {
  const match = /\n?^[ \t]*RELEVANT[ \t]*:[ \t]*(.*)$/im.exec(text)
  const answer = (match ? text.slice(0, match.index) : text).trim()
  const picked = (match?.[1] ?? '')
    .split(/[,\s]+/)
    .map((token) => Number.parseInt(token, 10))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= candidateCount)
  return { answer, picked: [...new Set(picked)] }
}

/**
 * Collapses the near-duplicates a keyword match produces — the same agent
 * matched three times, several runs of one agent — to one entry per type+title,
 * keeping the first (most recently updated) of each.
 */
export function dedupeResults(results: LibrarianResult[]): LibrarianResult[] {
  const seen = new Set<string>()
  return results.filter((r) => {
    const key = `${r.type}|${r.title.trim().toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
