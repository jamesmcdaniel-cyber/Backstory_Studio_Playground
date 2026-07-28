/**
 * The house report format. When an agent's final deliverable is a report (a
 * brief, digest, scorecard, account plan, priority matrix…), this instruction
 * makes it emit ONE self-contained HTML document that renders — inside the
 * app's sandboxed HtmlPreview and in the templates gallery — exactly like the
 * advertised template output: hero header with a status pill, stat tiles,
 * executive summary, evidence-backed findings, an action plan, an evidence
 * trail, and an outcome banner.
 *
 * Kept in its own module so the prompt text is unit-testable and reusable
 * (system prompt + template example outputs share the same design language).
 */

/**
 * The house stylesheet. Inline <style> only — the preview iframe is sandboxed
 * and the email path forbids external assets, so documents must be fully
 * self-contained. Shared with the templates gallery's example outputs
 * (src/lib/templates/example-reports) so the advertised example and a live run
 * render identically.
 */
export const REPORT_CSS = `
body{margin:0;background:#f1f5f9;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:#0f172a;padding:24px}
.report{max-width:960px;margin:0 auto}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:20px 24px;margin-bottom:16px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
.hero{background:linear-gradient(135deg,#ecfdf5,#ffffff 60%);display:flex;justify-content:space-between;gap:16px}
.eyebrow{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#047857;margin:0 0 6px}
h1{font-size:22px;margin:0 0 6px}h2{font-size:16px;margin:0}
.sub{color:#475569;font-size:14px;margin:0}
.pill{display:inline-flex;align-items:center;gap:6px;border:1px solid #d1fae5;background:#fff;border-radius:999px;padding:4px 12px;font-size:12px;font-weight:600;color:#065f46;white-space:nowrap;height:fit-content}
.dot{width:7px;height:7px;border-radius:999px;background:#10b981;display:inline-block}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
.stat{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:14px 16px}
.stat b{font-size:18px}.stat span{display:block;color:#64748b;font-size:12px;margin-top:2px}
.summary{border-left:3px solid #10b981}.summary p{color:#334155;font-size:14px;line-height:1.6;margin:10px 0 0}
.head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.count{border:1px solid #e2e8f0;border-radius:999px;padding:3px 10px;font-size:12px;color:#334155;background:#fff}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#64748b;text-align:left;padding:10px 12px;background:#f8fafc}
td{padding:12px;border-top:1px solid #e2e8f0;vertical-align:top}
.num{color:#64748b;width:32px}.right{text-align:right}.muted{color:#64748b}
.prio-high{color:#047857;font-weight:700;font-size:12px}.prio-med{color:#b45309;font-weight:700;font-size:12px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.mini{background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px}
.mini b{font-size:13.5px}.mini p{margin:4px 0;color:#475569;font-size:13px}.mini small{color:#94a3b8;font-size:11.5px}
.banner{background:#0f172a;color:#f8fafc;border-radius:14px;text-align:center;padding:14px;font-size:13px;font-weight:600}
`

/**
 * Wraps report body markup in the self-contained house document.
 */
export function reportDocument(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${REPORT_CSS}</style></head><body><div class="report">\n${body}\n</div></body></html>`
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
  'REPORT DELIVERABLES: when the final deliverable is a report — the objective, an attached skill, or the user asks for a report, brief, digest, scorecard, account plan, priority matrix, or a multi-section analysis of records — format the ENTIRE final response as ONE self-contained HTML document instead of Markdown, following the house report design below exactly. Plain conversational answers, short factual replies, and intermediate outputs another step will consume stay Markdown/plain text.',
  'Hard rules for the HTML report: start with <!doctype html>; ALL styling inline or in the single <style> block shown below; NO scripts, NO external stylesheets, fonts, or images (they will not load in the sandboxed preview) — use emoji as icons; every metric, name, date, and finding must come from this run\'s real context and tool results (omit a section entirely rather than inventing placeholder data); state counts precisely and flag data gaps inside the report.',
  `House report skeleton — reproduce this structure, classes, and <style> block verbatim, then fill it with real data (add table rows/stat tiles/evidence cards as needed; use class "prio-high" for high priority and "prio-med" for medium):\n${REPORT_HTML_SKELETON}`,
  'Adapt the middle sections to the task while keeping the same visual language: a scoring matrix, stakeholder list, or week-by-week plan is another eyebrow + heading + table card; extra narrative is another summary-style card. Always keep the hero header first, the stat row second, and the dark outcome banner last.',
  'The document IS the whole final response: emit it raw, starting at <!doctype html> — never inside a code fence, never introduced by a sentence, and never followed by a Markdown recap of what it says. If you ALSO deliver the report somewhere (email, Slack, a file), send the same document adapted to that channel\'s constraints and still return the full document as your final response — a report that was emailed is not an excuse to answer in Markdown.',
  'If your instructions specify a required output shape for this run — named sections, headings, stat labels, or table columns — that shape wins: produce those sections, in that order, inside this house format. Where the data is thin, keep the section and state the gap in place rather than dropping it.',
].join('\n')
