import { reportDocument } from '@/features/agents/report-format'

/**
 * Builders for the templates gallery's illustrative outputs. Every built-in
 * template advertises the same house report format a live run produces (see
 * src/features/agents/report-format.ts) — hero, stat row, executive summary,
 * evidence-backed tables, evidence trail, outcome banner — so the gallery
 * preview and the real deliverable are the same artifact.
 */

/** A table cell: plain text, or text plus a house class (`prio-high`, `right`, `muted`). */
export type Cell = string | { v: string; c: string }

const cell = (tag: 'td' | 'th', c: Cell) =>
  typeof c === 'string' ? `<${tag}>${c}</${tag}>` : `<${tag} class="${c.c}">${c.v}</${tag}>`

const row = (tag: 'td' | 'th', cells: Cell[]) => `<tr>${cells.map((c) => cell(tag, c)).join('')}</tr>`

/** High-priority cell (green). */
export const high = (v: string): Cell => ({ v, c: 'prio-high' })
/** Medium-priority cell (amber). */
export const med = (v: string): Cell => ({ v, c: 'prio-med' })
/** Right-aligned numeric cell. */
export const num = (v: string): Cell => ({ v, c: 'right' })
/** De-emphasised cell (sources, row numbers, dates). */
export const dim = (v: string): Cell => ({ v, c: 'muted' })

export type ReportSpec = {
  /** Uppercase report kind, e.g. "Pipeline intelligence report". */
  eyebrow: string
  title: string
  /** One sentence describing what the run did. */
  sub: string
  /** Status pill text, e.g. "3 of 20 need action · Delivered". */
  pill: string
  /** 3–5 headline metrics: [emoji, value, label]. */
  stats: [string, string, string][]
  /** 2–4 grounded sentences: situation, momentum, single most important next move. */
  summary: string
  sections: Section[]
  /** Evidence trail cards: [source, what it contributed, freshness]. */
  evidence: [string, string, string][]
  /** Dark outcome banner. */
  banner: string
}

export type Section =
  | {
      kind: 'table'
      eyebrow: string
      heading: string
      /** Right-hand chip, e.g. "Top 5 of 18 scored". */
      count: string
      head: Cell[]
      rows: Cell[][]
      /** Optional caption printed under the table. */
      note?: string
    }
  | { kind: 'note'; heading: string; body: string }

const tableSection = (s: Extract<Section, { kind: 'table' }>) =>
  `<div class="card"><p class="eyebrow">${s.eyebrow}</p><div class="head"><h2>${s.heading}</h2>` +
  `<span class="count">${s.count}</span></div><table>${row('th', s.head)}` +
  `${s.rows.map((r) => row('td', r)).join('')}</table>` +
  `${s.note ? `<p class="sub" style="margin-top:10px">${s.note}</p>` : ''}</div>`

const noteSection = (s: Extract<Section, { kind: 'note' }>) =>
  `<div class="card summary"><h2>${s.heading}</h2><p>${s.body}</p></div>`

/** Renders a spec into the self-contained house HTML document. */
export function report(spec: ReportSpec): string {
  const hero =
    `<div class="card hero"><div><p class="eyebrow">${spec.eyebrow}</p><h1>${spec.title}</h1>` +
    `<p class="sub">${spec.sub}</p></div><span class="pill"><span class="dot"></span>${spec.pill}</span></div>`
  const stats =
    `<div class="stats">${spec.stats
      .map(([icon, value, label]) => `<div class="stat">${icon} <b>${value}</b><span>${label}</span></div>`)
      .join('')}</div>`
  const summary = `<div class="card summary"><h2>✨ Executive summary</h2><p>${spec.summary}</p></div>`
  const sections = spec.sections
    .map((s) => (s.kind === 'table' ? tableSection(s) : noteSection(s)))
    .join('\n')
  const evidence =
    `<div class="card"><h2>🧾 Evidence trail</h2><div class="cards">${spec.evidence
      .map(([name, what, when]) => `<div class="mini"><b>${name}</b><p>${what}</p><small>↻ ${when}</small></div>`)
      .join('')}</div></div>`
  const banner = `<div class="banner">${spec.banner}</div>`
  return reportDocument([hero, stats, summary, sections, evidence, banner].join('\n'))
}

/**
 * Marks the generated output contract inside a template's instructions, so it
 * is appended exactly once no matter how many times the instructions are
 * enhanced on their way to an agent.
 */
export const OUTPUT_CONTRACT_MARKER = '## Required output shape'

/** The visible text of a cell, stripped of its house class. */
const label = (c: Cell): string => (typeof c === 'string' ? c : c.v)

/** Entities are for the rendered HTML; the instruction text reads better raw. */
const plain = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

const clip = (s: string, max = 260): string => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`)

const statLine = (stats: ReportSpec['stats']): string =>
  stats.map(([icon, , text]) => `${icon} "${text}"`).join(' · ')

const sectionLine = (s: Section): string => {
  if (s.kind === 'note') {
    return `Narrative card "${plain(s.heading)}" — a short prose block at this altitude: "${clip(plain(s.body))}"`
  }
  const columns = s.head.map((c) => plain(label(c))).join(' | ')
  const first = s.rows[0] ? s.rows[0].map((c) => plain(label(c))).join(' · ') : ''
  return [
    `Table card "${plain(s.heading)}" — eyebrow "${plain(s.eyebrow)}", count chip in the form "${plain(s.count)}"`,
    `   Columns (exactly these, in order): ${columns}`,
    first ? `   A row reads like: ${first}` : '',
    s.note ? `   Closing caption in the form: "${clip(plain(s.note))}"` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * The per-template delivery contract, generated from the SAME spec that renders
 * the template's advertised output example. Appended to a built-in template's
 * instructions so the agent is told the exact section order, headings, column
 * sets, and stat labels its gallery example promises — the generic house-format
 * rule in the system prompt only describes the shell, which left every run free
 * to invent its own sections (or fall back to Markdown).
 *
 * Generated rather than hand-written so the instruction and the example can
 * never drift apart.
 */
export function outputContract(spec: ReportSpec): string {
  const numbered: string[] = [
    `Hero card — eyebrow "${plain(spec.eyebrow).toUpperCase()}", an <h1> title in the form "${plain(spec.title)}", one subtitle sentence saying what THIS run did (the example's reads "${plain(spec.sub)}"), and a status pill in the form "${plain(spec.pill)}" carrying this run's real counts.`,
    `Stat row — exactly ${spec.stats.length} tiles, in this order, with these emoji and labels: ${statLine(spec.stats)}. Keep the emoji and labels; replace the values with this run's numbers.`,
    `"✨ Executive summary" — 2–4 grounded sentences covering the situation, the momentum, and the single most important next move, at this altitude: "${clip(plain(spec.summary), 400)}"`,
    ...spec.sections.map(sectionLine),
    `"🧾 Evidence trail" — one mini card per source you actually used this run, each with what it contributed and its freshness (the example cites ${spec.evidence.map(([name]) => plain(name)).join(', ')}). List only sources this run really touched, and include a "Data gaps" card whenever something was skipped.`,
    `Dark outcome banner, last — same shape as "${plain(spec.banner)}", stating what this run actually produced and delivered.`,
  ]

  return [
    OUTPUT_CONTRACT_MARKER,
    '',
    "This template advertises an output example, and that example IS the delivery contract. The final deliverable must be ONE self-contained HTML document in the house report format (see REPORT DELIVERABLES in your system instructions) containing the sections below, in this order, with these exact headings, emoji, column sets, and stat labels.",
    '',
    ...numbered.map((line, i) => `${i + 1}. ${line}`),
    '',
    'Rules for this template:',
    "- Every quoted value above is illustrative, taken from a different run. Mirror the SHAPE and wording style; never reuse the example's numbers, account names, people, or dates.",
    '- The HTML document IS the entire final response. Do not wrap it in a code fence, do not precede it with a Markdown recap, and do not summarise it afterwards.',
    '- When you also email or post the report, that message body is the same document rendered email-safe (inline CSS, no <style> block) — the final response still carries the full document.',
    '- Keep every section even when data is thin: state the gap in place ("no usage telemetry for 5 accounts") rather than dropping the section or inventing values.',
    '- Add rows, tiles, or an extra card when this run genuinely has more to show, but never remove or reorder the sections above.',
  ].join('\n')
}

/** Standard "recommended execution" action-plan section. */
export function actionPlan(rows: [string, string, string][], count = 'Owner + date assigned'): Section {
  return {
    kind: 'table',
    eyebrow: 'Recommended execution',
    heading: '✅ Action plan',
    count,
    head: ['#', 'Next action', 'Owner', 'Due'],
    rows: rows.map(([action, owner, due], i) => [dim(String(i + 1)), action, owner, due]),
  }
}
