/**
 * The house report format. When an agent's final deliverable is a report (a
 * brief, digest, scorecard, account plan, priority matrix…), this instruction
 * makes it emit ONE self-contained HTML document that renders — inside the
 * app's sandboxed HtmlPreview and in the templates gallery — exactly like the
 * advertised template output: hero header with a status pill, stat tiles,
 * executive summary, evidence-backed findings, an action plan, an evidence
 * trail, and an outcome banner.
 *
 * The shell is shared; the color identity is not. Each artifact family gets a
 * named theme (a `.theme-*` class on the report wrapper that swaps the CSS
 * custom properties), so an account plan, a cockpit, and a coaching scorecard
 * are recognizably different documents at a glance.
 *
 * Kept in its own module so the prompt text is unit-testable and reusable
 * (system prompt + template example outputs share the same design language).
 */

/** Artifact families with a distinct color identity. */
export type ReportTheme = 'revenue' | 'account' | 'brief' | 'cockpit' | 'overview' | 'coaching'

/**
 * Theme palette: [hero tint, soft border, accent, strong text, deep text].
 * `revenue` (emerald) is the default, carried by `.report` itself.
 */
export const REPORT_THEMES: Record<ReportTheme, [string, string, string, string, string]> = {
  revenue: ['#ecfdf5', '#d1fae5', '#10b981', '#047857', '#065f46'],
  account: ['#eff6ff', '#bfdbfe', '#3b82f6', '#1d4ed8', '#1e40af'],
  brief: ['#f5f3ff', '#ddd6fe', '#8b5cf6', '#6d28d9', '#5b21b6'],
  cockpit: ['#ecfeff', '#a5f3fc', '#06b6d4', '#0e7490', '#155e75'],
  overview: ['#fffbeb', '#fde68a', '#f59e0b', '#b45309', '#92400e'],
  coaching: ['#fff1f2', '#fecdd3', '#f43f5e', '#be123c', '#9f1239'],
}

const themeVars = (t: ReportTheme): string => {
  const [tint, soft, accent, strong, deep] = REPORT_THEMES[t]
  return `--tint:${tint};--soft:${soft};--accent:${accent};--strong:${strong};--deep:${deep}`
}

/**
 * Picks the artifact family for a report kind (the hero eyebrow / deliverable
 * name). The same mapping, in words, is taught to the agent in
 * REPORT_HTML_INSTRUCTION — keep the two in sync.
 */
export function themeForKind(kind: string): ReportTheme {
  const k = kind.toLowerCase()
  if (/coaching|win\/loss|debrief|scorecard|qbr|business review|coverage|hygiene/.test(k)) return 'coaching'
  if (/brief|prospecting|content|messaging/.test(k)) return 'brief'
  if (/account|readiness|renewal|onboarding|relationship|territory/.test(k)) return 'account'
  if (/cockpit|dashboard|monitor|blueprint|normalization|routing|resolution|validation|migration|rollout|regression/.test(k)) return 'cockpit'
  if (/overview|audit|triage|whitespace|summary|handoff|update/.test(k)) return 'overview'
  return 'revenue'
}

/**
 * The house stylesheet. Inline <style> only — the preview iframe is sandboxed
 * and the email path forbids external assets, so documents must be fully
 * self-contained. Shared with the templates gallery's example outputs
 * (src/lib/templates/example-reports) so the advertised example and a live run
 * render identically.
 *
 * All accent colors flow through CSS custom properties set on `.report`
 * (emerald default) and overridden by the `.theme-*` classes, so one <style>
 * block serves every artifact family.
 */
export const REPORT_CSS = `
body{margin:0;background:#f1f5f9;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:#0f172a;padding:24px}
.report{max-width:960px;margin:0 auto;${themeVars('revenue')}}
.theme-account{${themeVars('account')}}
.theme-brief{${themeVars('brief')}}
.theme-cockpit{${themeVars('cockpit')}}
.theme-overview{${themeVars('overview')}}
.theme-coaching{${themeVars('coaching')}}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:20px 24px;margin-bottom:16px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.hero{background:linear-gradient(135deg,var(--tint),#ffffff 60%);display:flex;justify-content:space-between;gap:16px}
.eyebrow{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--strong);margin:0 0 6px}
h1{font-size:22px;margin:0 0 6px}h2{font-size:16px;margin:0}
.sub{color:#475569;font-size:14px;margin:0}
.pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--soft);background:#fff;border-radius:999px;padding:4px 12px;font-size:12px;font-weight:600;color:var(--deep);white-space:nowrap;height:fit-content}
.dot{width:7px;height:7px;border-radius:999px;background:var(--accent);display:inline-block}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
.stat{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:14px 16px}
.stat b{font-size:18px}.stat span{display:block;color:#64748b;font-size:12px;margin-top:2px}
.summary{border-left:3px solid var(--accent)}.summary p{color:#334155;font-size:14px;line-height:1.6;margin:10px 0 0}
.head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.count{border:1px solid #e2e8f0;border-radius:999px;padding:3px 10px;font-size:12px;color:#334155;background:#fff}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#64748b;text-align:left;padding:10px 12px;background:#f8fafc}
td{padding:12px;border-top:1px solid #e2e8f0;vertical-align:top}
.num{color:#64748b;width:32px}.right{text-align:right}.muted{color:#64748b}
.prio-high{color:var(--strong);font-weight:700;font-size:12px}.prio-med{color:#b45309;font-weight:700;font-size:12px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.mini{background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px}
.mini b{font-size:13.5px}.mini p{margin:4px 0;color:#475569;font-size:13px}.mini small{color:#94a3b8;font-size:11.5px}
.banner{background:#0f172a;color:#f8fafc;border-radius:14px;text-align:center;padding:14px;font-size:13px;font-weight:600}
.bar{height:8px;background:#e2e8f0;border-radius:999px;overflow:hidden;margin-top:6px}.bar span{display:block;height:100%;background:var(--accent);border-radius:999px}
.delta{font-size:12px;font-weight:700}.delta.up{color:#047857}.delta.down{color:#b91c1c}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.tag{border:1px solid var(--soft);background:var(--tint);color:var(--deep);border-radius:999px;padding:3px 10px;font-size:12px;font-weight:600}
.tl{border-left:2px solid var(--soft);margin:8px 0 0 6px;padding-left:16px}.tl-item{position:relative;margin-bottom:12px}.tl-item:before{content:"";position:absolute;left:-21px;top:4px;width:8px;height:8px;border-radius:999px;background:var(--accent)}.tl-item p{margin:2px 0 0;color:#475569;font-size:13px}
`

/**
 * Wraps report body markup in the self-contained house document. Pass a theme
 * to give the artifact its family's color identity; omitting it keeps the
 * emerald revenue default.
 */
export function reportDocument(body: string, theme?: ReportTheme): string {
  const cls = theme && theme !== 'revenue' ? `report theme-${theme}` : 'report'
  return `<!doctype html><html><head><meta charset="utf-8"><style>${REPORT_CSS}</style></head><body><div class="${cls}">\n${body}\n</div></body></html>`
}

/**
 * Rewrites a house report document so it renders faithfully in email clients.
 *
 * Gmail (and most webmail) honors a <style> block in <head>, but strips CSS
 * custom properties — every `var(--…)` resolves to nothing, which erases the
 * theme's colors (eyebrows, pills, priority text, summary borders, tags,
 * timeline dots). This resolves the wrapper's theme and substitutes the
 * literal color values, so the emailed document IS the on-screen document.
 * Unsupported niceties (grid, box-shadow, ::before dots) degrade gracefully
 * to stacked blocks. Non-report HTML passes through untouched.
 */
export function emailSafeReportHtml(html: string): string {
  const wrapper = html.match(/class="report(?:\s+theme-([a-z]+))?"/)
  if (!wrapper) return html
  const theme: ReportTheme = wrapper[1] && wrapper[1] in REPORT_THEMES ? (wrapper[1] as ReportTheme) : 'revenue'
  const [tint, soft, accent, strong, deep] = REPORT_THEMES[theme]
  const values: Record<string, string> = { tint, soft, accent, strong, deep }
  return html.replace(/var\(--(tint|soft|accent|strong|deep)\)/g, (_, name: string) => values[name])
}

/**
 * Document skeleton the model reproduces, with placeholder content.
 */
export const REPORT_HTML_SKELETON = reportDocument(`<div class="card hero"><div><p class="eyebrow">REPORT KIND (e.g. REVENUE INTELLIGENCE REPORT)</p><h1>Title</h1><p class="sub">One-sentence description of what this run did.</p></div><span class="pill"><span class="dot"></span>Status · e.g. Qualified · Action ready</span></div>
<div class="stats"><div class="stat">💰 <b>$84K</b><span>Qualified ARR</span></div><!-- 3–5 headline metrics, each with an emoji, bold value, and label --></div>
<div class="card summary"><h2>✨ Executive summary</h2><p>2–4 grounded sentences: the situation, the momentum, and the single most important next move.</p></div>
<div class="card"><p class="eyebrow">Evidence-backed analysis</p><div class="head"><h2>🔎 Priority findings</h2><span class="count">N findings</span></div><table><tr><th>Priority</th><th>Finding</th><th>What the evidence says</th><th>Source</th></tr><tr><td class="prio-high">High</td><td>Finding title</td><td>The concrete evidence sentence.</td><td class="muted">System · date</td></tr></table></div>
<div class="card"><p class="eyebrow">Recommended execution</p><div class="head"><h2>✅ Action plan</h2><span class="count">Owner + date assigned</span></div><table><tr><th>#</th><th>Next action</th><th>Owner</th><th>Due</th></tr><tr><td class="num">1</td><td>Action</td><td>Owner</td><td>Date</td></tr></table></div>
<div class="card"><h2>🧾 Evidence trail</h2><div class="cards"><div class="mini"><b>Source name</b><p>What it contributed.</p><small>↻ Updated 2h ago</small></div></div></div>
<div class="banner">🎉 Outcome one · Outcome two · Outcome three</div>`)

export const REPORT_HTML_INSTRUCTION = [
  'REPORT DELIVERABLES vs CONVERSATION — decide first, every time. Produce the HTML report document ONLY when the run\'s objective, an attached skill, a template output contract, or an explicit user request calls for a standing report artifact: a brief, digest, scorecard, account plan, account analysis, cockpit, overview, priority matrix, or another multi-section analysis of records the user will keep or share. Everything else is CONVERSATION and stays plain Markdown — never HTML: drafting or proposing content for the user to review or approve (email drafts, Slack posts, message copy, topic/idea proposals in a draft-and-approve loop), giving advice or recommendations, answering questions, explaining something, status updates, and intermediate outputs another step will consume. A message you are drafting FOR the user to send is conversation (show the draft as Markdown, e.g. in a blockquote), even if the request uses words like "brief" or "report". When in doubt, answer in Markdown — an unnecessary report artifact reads as noise.',
  'Hard rules for the HTML report: start with <!doctype html>; ALL styling inline or in the single <style> block shown below; NO scripts, NO external stylesheets, fonts, or images (they will not load in the sandboxed preview) — use emoji as icons; every metric, name, date, and finding must come from this run\'s real context and tool results (omit a section entirely rather than inventing placeholder data); state counts precisely and flag data gaps inside the report.',
  `House report skeleton — reproduce this structure, classes, and <style> block verbatim, then fill it with real data (add table rows/stat tiles/evidence cards as needed; use class "prio-high" for high priority and "prio-med" for medium):\n${REPORT_HTML_SKELETON}`,
  'REPORT THEME — every artifact family has its own color identity. Set the wrapper class to `report theme-<family>` (plain `report` = emerald revenue default), choosing the family that matches the deliverable: theme-brief (violet) for briefs, prospecting or content/messaging strategy; theme-account (blue) for account plans, account analyses, readiness, renewals, onboarding or territory work; theme-cockpit (cyan) for cockpits, dashboards, monitors and ops/run reports; theme-overview (amber) for overviews, audits, triage and summaries; theme-coaching (rose) for coaching, scorecards, win/loss and QBR packs; revenue/pipeline/deal intelligence, digests and alerts keep the emerald default. Pick exactly one theme and keep it for the whole document.',
  'DYNAMIC ELEMENTS — use the house modules where the data genuinely supports them, instead of forcing everything into tables: a progress bar `<div class="bar"><span style="width:72%"></span></div>` for scores, attainment, health or completion; a trend `<span class="delta up">▲ 12%</span>` / `<span class="delta down">▼ 8%</span>` next to a stat value; chips `<div class="tags"><span class="tag">Pillar name</span></div>` for pillars, topics, segments or stakeholder roles; a timeline `<div class="tl"><div class="tl-item"><b>Week 1</b><p>Milestone.</p></div></div>` for phased plans. Cockpits lean on bars and deltas; briefs on tags; plans on timelines. Never invent numbers to feed a module — skip it instead.',
  'Adapt the middle sections to the task while keeping the same visual language: a scoring matrix, stakeholder list, or week-by-week plan is another eyebrow + heading + table card; extra narrative is another summary-style card. Always keep the hero header first, the stat row second, and the dark outcome banner last.',
  'The document IS the whole final response: emit it raw, starting at <!doctype html> — never inside a code fence, and never preceded or followed by ANY other text. No preamble of any kind: no run narration or "summary of what was done", no data-source/tool-call/delegation recap, no delivery confirmation ("Email sent successfully…"), no Markdown recap of what the report says — the run log already shows all of that. Disclosures the reader actually needs (data gaps, what was and was not scored, timed-out or unconfirmed lookups) go inside the report\'s own sections, not in front of it. If you ALSO deliver the report somewhere (email, Slack, a file), send the same document at FULL fidelity — every section, every table row, every card, identical numbers — with only the channel\'s formatting mechanics changed (e.g. inline CSS for email); never send a condensed, summarized, or "executive" version to one channel while the full report lives in another, and still return the full document as your final response — a report that was emailed is not an excuse to answer in Markdown.',
  'If your instructions specify a required output shape for this run — named sections, headings, stat labels, or table columns — that shape wins: produce those sections, in that order, inside this house format. Where the data is thin, keep the section and state the gap in place rather than dropping it.',
].join('\n')
