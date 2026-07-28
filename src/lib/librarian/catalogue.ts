import { builtInTemplates } from '@/lib/templates/builtin-agents'
import { BUILTIN_FLOW_TEMPLATES } from '@/lib/flows/templates/builtin'
import type { LibrarianResult } from '@/lib/librarian/relevance'

/**
 * Searching the catalogue the platform SHIPS — the built-in agent templates and
 * flow templates.
 *
 * These live in code, not in `agent_templates` / `flow_templates` rows, so the
 * Assistant's database search could never see them: asked "which template
 * generates meeting briefs?" it answered that it had no information, while the
 * gallery shipped a "Meeting Brief" template. Everything here is pure over the
 * two catalogues, so the ranking is directly testable.
 */

type Candidate = { result: LibrarianResult; haystack: string }

/**
 * A query term matches when it appears in the text, or when its singular does —
 * so "briefs" finds "Meeting Brief" and "agents" finds an agent template.
 * Deliberately cruder than a stemmer: this only has to rank a few hundred short
 * titles, and a wrong stem costs relevance the model then has to see past.
 */
export function termMatches(term: string, haystack: string): boolean {
  if (haystack.includes(term)) return true
  return term.length > 3 && term.endsWith('s') && haystack.includes(term.slice(0, -1))
}

function candidates(): Candidate[] {
  const agents = builtInTemplates.map((template): Candidate => ({
    result: {
      type: 'template',
      id: template.id,
      title: template.name,
      subtitle: `Agent template · ${template.category}`,
      href: `/templates/${template.id}`,
    },
    // "agent template" is part of the text on purpose: a question phrased as
    // "which template…" should match a template, which its name rarely says.
    haystack: [
      template.name,
      template.description,
      template.category,
      (template.tags ?? []).join(' '),
      (template.integrations ?? []).join(' '),
      'agent template',
    ]
      .join(' ')
      .toLowerCase(),
  }))

  const flows = BUILTIN_FLOW_TEMPLATES.map((template): Candidate => ({
    result: {
      type: 'flow',
      id: template.id,
      title: template.name,
      subtitle: `Flow template · ${template.category}`,
      href: `/flow-templates/${template.id}`,
    },
    haystack: [
      template.name,
      template.description,
      template.category,
      template.tags.join(' '),
      template.integrations.join(' '),
      template.notes.objective,
      'flow template pipeline',
    ]
      .join(' ')
      .toLowerCase(),
  }))

  return [...agents, ...flows]
}

/**
 * The built-in agent and flow templates that match a question's terms, best
 * first. Ranked by how many distinct terms hit; ties keep catalogue order, so
 * the curated ordering decides between equally-good matches.
 */
export function searchBuiltinCatalogue(terms: string[], limit = 6): LibrarianResult[] {
  if (!terms.length) return []
  return candidates()
    .map((candidate, index) => ({
      index,
      result: candidate.result,
      hits: terms.filter((term) => termMatches(term, candidate.haystack)).length,
    }))
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.result)
}
