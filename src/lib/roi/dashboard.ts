import { LEGACY_TAB, type RoiNarrative } from './contract'
import type { RoiFacts } from './prep'
import type { Account360Facts } from './account360/prep'
import { EMPTY_VIEW, type RoiView } from './view'
import { configFromPreset, describeRunConfig, MONTH_NAMES, resolveWindows, type RoiRunConfig } from './config'
import { encodeMatrix } from './facts'
import { REPORT_CSS } from './report-css'
import { REPORT_SCRIPT } from './report-script'
import { hasLiveData, type RoiLiveAccount } from './live-account'

/**
 * The ROI report — Backstory's value readout, generic across customer
 * accounts (and Backstory's own), drawn in the Iron Mountain dashboard's UI.
 *
 * Tabs follow the value readout, and every element of the Iron Mountain
 * dashboard sits inside them once:
 *
 *   Executive summary · Activity trends · Adoption impact · Deal engagement ·
 *   Stage and persona · Account engagement · Method
 *
 * Executive summary: the headline numbers, the findings cards, the scorecard
 * (observation vs baseline), the adoption overview, what to watch and the
 * upside calculator. Activity trends: the monthly trend, period comparison,
 * activity mix and senior engagement over three periods. Adoption impact:
 * high / medium / low tiers or users vs non-users (one switch), and the user
 * roster. Deal engagement: win rate and velocity by decile, level, month and
 * fiscal year, year-over-year findings, and the account-level view. Stage and
 * persona: the stage × persona heatmap, win rate by stage, persona lines,
 * survivorship and committee breadth. Account engagement: the Account 360
 * cohorts (when those extracts are loaded). Fiscal year, quarter and role
 * filters sit in a side panel behind a menu button — the ROI page hosts them
 * in its own panel instead (see RoiReportFrame).
 *
 * The data objects come from the preps (U, OPP, DEALS, ST, ACC, META, and the
 * Account 360 bundle), the prose from the analyst's narrative, the windows
 * from the run's configuration. Sections whose data is missing are left out.
 * Plotly loads from /vendor because the frame's CSP allows nothing off our
 * origin (fonts excepted).
 */

/**
 * The report layout's version, kept on every version's state. Raise it when
 * the layout changes: a person's page re-draws an account from its own state
 * the next time they open it, so saved pages take the new layout.
 */
export const ROI_RENDER_VERSION = 4

export type RoiDashboardOptions = {
  account: string
  generatedAt?: string
  /** The older preset; ignored when `config` is given. */
  timeframePreset?: string
  /** What to show and how it is labelled — see ./view.ts. */
  view?: RoiView
  /** The run's configuration from the ROI page. */
  config?: RoiRunConfig
  /** Why the analysis was run. */
  reason?: string
  /** The Account 360 prep's result, for the Account engagement tab. */
  a360?: Account360Facts | null
  /** The account today, read live from Backstory and Salesforce (a person's own page only). */
  live?: RoiLiveAccount | null
}

const moneyText = (value: number | null | undefined) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–'
  const a = Math.abs(value)
  return a >= 1e9 ? `$${(value / 1e9).toFixed(2)}B` : a >= 1e6 ? `$${(value / 1e6).toFixed(1)}M` : a >= 1e3 ? `$${Math.round(value / 1e3)}K` : `$${Math.round(value)}`
}

/** "Account today": the live Backstory and Salesforce read, drawn on the summary. */
function liveSection(live: RoiLiveAccount | null | undefined, account: string): string {
  if (!live || !hasLiveData(live)) return ''
  const fetched = new Date(live.fetchedAt)
  const when = Number.isNaN(fetched.getTime()) ? '' : fetched.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'
  const from = live.sources.filter((s) => s.ok).map((s) => s.name).join(' and ')
  const level = (score: number | null) => (score === null ? '' : `<span class="eng ${score <= 30 ? 'lo' : score <= 70 ? 'md' : 'hi'}">${Math.round(score)}</span>`)
  const sf = live.salesforce
  const tiles: string[] = []
  if (sf) {
    const closed = sf.closedWon + sf.closedLost
    tiles.push(`<div class="tile"><div class="k">Won deals · last 2 years</div><div class="v">${sf.closedWon.toLocaleString()}</div><div class="d">of ${closed.toLocaleString()} closed</div></div>`)
    if (closed) tiles.push(`<div class="tile"><div class="k">Win rate · Salesforce</div><div class="v">${((sf.closedWon / closed) * 100).toFixed(1)}%</div><div class="d">${sf.closedLost.toLocaleString()} lost</div></div>`)
    tiles.push(`<div class="tile"><div class="k">Won amount</div><div class="v">${moneyText(sf.wonAmount)}</div><div class="d">closed-won, last 2 years</div></div>`)
    if (sf.avgDaysToClose !== null) tiles.push(`<div class="tile"><div class="k">Days to close · won</div><div class="v">${sf.avgDaysToClose}</div><div class="d">average, created to closed</div></div>`)
    const openAmount = sf.openByStage.reduce((sum, s) => sum + s.amount, 0)
    if (sf.openByStage.length) tiles.push(`<div class="tile"><div class="k">Open pipeline</div><div class="v">${moneyText(openAmount)}</div><div class="d">${sf.openByStage.reduce((sum, s) => sum + s.count, 0)} open opportunities</div></div>`)
  }
  const opps = (live.opportunities ?? []).slice(0, 8)
  const people = live.people
  const status = live.status
  // Backstory bolds names and themes, not numbers: plain bold, not the number face.
  const strong = (text: string) => escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  const list = (items: string[]) => items.length ? `<ul>${items.map((item) => `<li>${strong(item)}</li>`).join('')}</ul>` : '<p class="muted">Nothing recorded in the last 30 days.</p>'
  return `<div class="live" data-section="live">
    <div class="section-lbl">${escapeHtml(live.account?.name ?? account)} today · live from ${escapeHtml(from || 'Backstory')}${when ? ` · ${escapeHtml(when)}` : ''}</div>
    ${tiles.length ? `<div class="tiles static score">${tiles.join('')}</div>` : ''}
    <div class="live-grid">
      ${opps.length ? `<div class="card"><h3>Open opportunities</h3><p class="sub">With Backstory's engagement score (low 0–30, medium 31–70, high 71+).</p><div class="tbl-wrap"><table><thead><tr><th>Opportunity</th><th>Type</th><th>Amount</th><th>Closes</th><th>Engagement</th></tr></thead><tbody>${opps.map((o) => `<tr><td>${escapeHtml(o.name)}</td><td class="txt">${escapeHtml(o.type ?? '—')}</td><td>${moneyText(o.amount)}</td><td>${escapeHtml(o.closeDate ?? '—')}</td><td>${level(o.engagement) || '—'}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
      ${people ? `<div class="card"><h3>Engaged in the last 30 days</h3><p class="sub">${people.externalCount} people at ${escapeHtml(live.account?.name ?? account)}, ${people.internalCount} on the team.</p><div class="tbl-wrap"><table><thead><tr><th>Person</th><th>Title</th><th>Emails</th><th>Meetings</th></tr></thead><tbody>${people.external.slice(0, 8).map((p) => `<tr><td>${escapeHtml(p.name)}</td><td class="txt">${escapeHtml(p.title || '—')}</td><td>${p.emails}</td><td>${p.meetings}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
    </div>
    ${status ? `<div class="live-status"><div><h4>Risks</h4>${list(status.risks)}</div><div><h4>Next steps</h4>${list(status.nextSteps)}</div><div><h4>What is being discussed</h4>${list(status.topics)}</div></div>` : ''}
    ${sf && (sf.byType.length || sf.byFy.length) ? `<div class="live-grid">
      ${sf.byFy.length ? `<div class="card"><h3>Closed deals by fiscal year · Salesforce</h3><div class="tbl-wrap"><table><thead><tr><th>Fiscal year</th><th>Won</th><th>Lost</th><th>Win rate</th><th>Won amount</th></tr></thead><tbody>${sf.byFy.map((f) => `<tr><td>${escapeHtml(f.fy)}</td><td>${f.won}</td><td>${f.lost}</td><td>${f.won + f.lost ? ((f.won / (f.won + f.lost)) * 100).toFixed(1) + '%' : '–'}</td><td>${moneyText(f.wonAmount)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
      ${sf.byType.length ? `<div class="card"><h3>Closed deals by type · Salesforce</h3><div class="tbl-wrap"><table><thead><tr><th>Type</th><th>Won</th><th>Lost</th><th>Win rate</th></tr></thead><tbody>${sf.byType.map((t) => `<tr><td>${escapeHtml(t.type)}</td><td>${t.won}</td><td>${t.lost}</td><td>${t.won + t.lost ? ((t.won / (t.won + t.lost)) * 100).toFixed(1) + '%' : '–'}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
    </div>` : ''}
    <p class="sub live-src">${live.sources.map((s) => `${escapeHtml(s.name)}: ${s.ok ? (s.note ? escapeHtml(s.note) : 'read live') : escapeHtml(s.note ?? 'unavailable')}`).join(' · ')}. Read with your own connections; it shows on your page only and refreshes every few hours.</p>
  </div>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)
}

/** JSON that is safe inside a <script> block: no way to close the tag early. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/<\//g, '<\\/')
    .replace(/<!--/g, '<\\!--')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/** Narrative paragraphs: escaped, with **bold** allowed for the numbers. */
function paragraphs(items: string[] | undefined): string {
  if (!items?.length) return ''
  return items.map((item) => `<p>${inline(item)}</p>`).join('')
}

function inline(text: string): string {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<b class="num">$1</b>')
}

function monthLabel(month: string): string {
  const [year, mm] = month.split('-')
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(mm) - 1]} ${year}`
}

/** The facts as this view shows them: hidden metrics dropped, labels applied, matrices compact. */
function viewFacts(facts: RoiFacts, view: RoiView): RoiFacts {
  if (!facts.U) return facts
  const hidden = new Set(view.hiddenMetrics)
  const labels: Record<string, string> = {}
  const matrices: Record<string, string> = {}
  for (const [key, label] of Object.entries(facts.U.labels)) {
    if (hidden.has(key)) continue
    labels[key] = view.metricLabels[key] ?? label
    matrices[key] = encodeMatrix(facts.U.m[key])
  }
  // A report with every metric hidden still needs one to draw.
  if (!Object.keys(labels).length) {
    const [key, label] = Object.entries(facts.U.labels)[0]
    labels[key] = label
    matrices[key] = encodeMatrix(facts.U.m[key])
  }
  // Breakdowns the activity tab needs even when their metric is hidden (the
  // senior mix reads VP and executive meetings).
  const mx: Record<string, string> = {}
  for (const [key, matrix] of Object.entries(facts.U.mx ?? {})) mx[key] = encodeMatrix(matrix)
  for (const key of ['vp_meeting_count', 'executive_meeting_count', 'meeting_count', 'sent_email_count']) {
    if (!(key in matrices) && facts.U.m[key]) mx[key] = encodeMatrix(facts.U.m[key])
  }
  return { ...facts, U: { ...facts.U, labels, m: matrices, mx } }
}

function a360Bundle(a360: Account360Facts | null | undefined) {
  if (!a360?.BUNDLE?.accounts?.length) return null
  return { B: a360.BUNDLE, M: a360.META, notes: a360.notes ?? [] }
}

export function renderRoiDashboard(rawFacts: RoiFacts, narrative: RoiNarrative, options: RoiDashboardOptions): string {
  const view = options.view ?? EMPTY_VIEW
  const facts = viewFacts(rawFacts, view)
  const config = options.config ?? configFromPreset(view.defaultComparison ?? options.timeframePreset)
  const account = options.account
  const generated = options.generatedAt ? new Date(options.generatedAt) : new Date()
  const generatedLabel = Number.isNaN(generated.getTime()) ? '' : generated.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
  const U = facts.U
  const windows = U ? resolveWindows(U.months, config) : null
  const a360 = a360Bundle(options.a360)
  const activityRange = U ? `Activity ${monthLabel(U.months[0])} – ${monthLabel(U.months[U.months.length - 1])}` : ''
  const dealCount = facts.DEALS?.w.length ?? (facts.OPP ? Object.values(facts.OPP)[0]?.incl.n : null)
  const reason = (options.reason ?? '').trim()
  const metaLine = [activityRange, dealCount ? `${Math.round(dealCount).toLocaleString()} closed deals` : '', generatedLabel ? `Generated ${generatedLabel}` : ''].filter(Boolean).join(' · ')
  const reps = facts.AGG ? facts.AGG.reps : U ? U.users.length : 0

  const eyebrow = ['Key findings', windows?.observationLabel ?? '', reps ? `${reps.toLocaleString()} reps` : '', reason ? `for ${reason}` : ''].filter(Boolean).join(' · ')
  const notes = narrative.notes
  const aside = (title: string, items: string[] | undefined, id?: string) => `<aside class="note"${id ? ` id="${id}"` : ''}><h4>${escapeHtml(title)}</h4>${paragraphs(items) || '<p class="muted">—</p>'}</aside>`
  const caveats = [...(narrative.caveats ?? []), ...(facts.notes ?? []), ...(a360?.notes ?? [])]
  // Narratives written for earlier layouts point at their tab ids.
  const normalized: RoiNarrative = { ...narrative, findings: narrative.findings.map((finding) => ({ ...finding, tab: LEGACY_TAB[finding.tab as string] ?? finding.tab })) }
  const runConfig = {
    windowMonths: config.windowMonths,
    comparison: config.comparison,
    custom: config.custom ?? null,
    cohort: config.cohort,
    fyStart: config.fiscalYearStartMonth ?? null,
    obs: windows?.observation ?? [],
    base: windows?.baseline ?? [],
    ly: windows?.yearAgo ?? [],
    obsLabel: windows?.observationLabel ?? '',
    baseLabel: windows?.baselineLabel ?? '',
    lyLabel: windows?.yearAgoLabel ?? null,
  }
  // Long headlines step down in size instead of filling the masthead.
  const headlineClass = normalized.headline.length > 150 ? ' class="xlong"' : normalized.headline.length > 95 ? ' class="long"' : ''
  const configLines = describeRunConfig(config)
  const findingsWord = ['two', 'three', 'four', 'five', 'six'][normalized.findings.length - 2] ?? 'four'
  const context = normalized.context

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Backstory value readout · ${escapeHtml(account)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cardo:wght@400;700&family=Chivo+Mono:wght@400;500;700&family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet">
<script src="/vendor/plotly.min.js"></script>
<style>${REPORT_CSS}${view.hiddenSections.map((section) => `[data-section="${section.replace(/[^a-zA-Z0-9]/g, '')}"]{display:none!important}`).join('')}</style>
</head>
<body>
<header class="mast">
  <div class="wrap">
    <div class="topbar">
      <div class="brand">
        <svg viewBox="0 0 22 18" aria-hidden="true"><rect x="0" y="2" width="4" height="16" fill="currentColor"/><rect x="6" y="0" width="4" height="18" fill="currentColor"/><rect x="12.5" y="3" width="4" height="15" transform="rotate(-12 14.5 10.5)" fill="currentColor"/></svg>
        <span class="wordmark">Backstory</span><span class="brand-sub">Value readout</span>
      </div>
      <div class="mast-meta"><b>${escapeHtml(account)}</b>${metaLine ? ` · ${escapeHtml(metaLine)}` : ''}</div>
      <button class="themebtn" id="themeBtn" type="button">Theme: auto</button>
    </div>
    <div class="mast-grid">
      <div>
        <div class="eyebrow">${escapeHtml(eyebrow)}</div>
        <h1${headlineClass}>${escapeHtml(normalized.headline)}</h1>
        <p class="lede">${inline(normalized.lede)}</p>
      </div>
      <figure class="strip-wrap" data-section="hero">
        <div id="heroStrip" role="img" aria-label="Headline chart"></div>
        <figcaption id="heroCap">Win rate by engagement decile, lowest to highest (non-transactional deals, excluding renewals)</figcaption>
      </figure>
    </div>
    <div class="hero-stats" id="heroStats" data-section="heroStats"></div>
  </div>
  <div class="stripe" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
</header>

<nav class="tabs" aria-label="Sections"><div class="wrap navrow">
  <button type="button" class="hamburger" id="filtersBtn" aria-label="Filters" aria-controls="filterPanel" aria-expanded="false"><span></span><span></span><span></span></button>
  <div class="tablist" role="tablist">
  <button role="tab" type="button" data-tab="summary" aria-selected="true">Executive summary</button>
  <button role="tab" type="button" data-tab="activity" aria-selected="false">Activity trends</button>
  <button role="tab" type="button" data-tab="adoption" aria-selected="false">Adoption impact</button>
  <button role="tab" type="button" data-tab="deals" aria-selected="false">Deal engagement</button>
  <button role="tab" type="button" data-tab="stage" aria-selected="false">Stage and persona</button>
  <button role="tab" type="button" data-tab="accounts" aria-selected="false">Account engagement</button>
  <button role="tab" type="button" data-tab="method" aria-selected="false">Method</button>
  </div>
  <span class="gf-badge" id="gfBadge"></span>
</div></nav>
<div class="scrim" id="filterScrim" hidden></div>
<aside class="filter-panel" id="filterPanel" aria-label="Filters" hidden>
  <div class="fp-head"><h2>Filters</h2><button type="button" class="fp-close" id="filtersClose" aria-label="Close filters">×</button></div>
  <p class="fp-hint">Fiscal year and quarter slice the deal and stage views; role narrows the reps behind the activity and adoption views.</p>
  <div class="fp-group" id="gfFyWrap"><h3>Fiscal year</h3><div class="chips" id="gfFy"></div></div>
  <div class="fp-group" id="gfFqWrap"><h3>Quarter</h3><div class="chips" id="gfFq"></div></div>
  <div class="fp-group" id="gfRoleWrap"><h3>Role</h3><div class="chips" id="gfRole"></div></div>
  <button type="button" class="gf-clear" id="gfClear">Clear filters</button>
</aside>

<main>
<section class="panel active" id="p-summary"><div class="wrap">
  ${context ? `<div class="ctx" data-section="context"><div class="eyebrow">Account context · Backstory</div><p>${inline(context.summary)}</p>${context.facts.length ? `<dl>${context.facts.map((fact) => `<div><dt>${escapeHtml(fact.label)}</dt><dd>${escapeHtml(fact.value)}<small>${escapeHtml(fact.source || 'Backstory')}</small></dd></div>`).join('')}</dl>` : ''}</div>` : ''}
  ${liveSection(options.live, account)}
  <div class="section-lbl">What the data shows</div>
  <h2>The ROI story in ${findingsWord} numbers</h2>
  <p class="intro">Each figure is traceable to a view in this readout. The chain runs from product usage, to rep behaviour, to deal engagement, to outcomes.</p>
  <div class="fgrid" id="findings" data-section="findings"></div>
  <div data-section="scorecard" id="scoreBlock">
    <div class="section-lbl">Scorecard · <span id="scoreWin"></span></div>
    <div class="tiles static score" id="scoreKpis"></div>
  </div>
  <div data-section="overview" id="overviewBlock">
    <div class="section-lbl">Adoption overview</div>
    <div class="cards2 flush">
      <div class="card"><h3>Usage cohorts</h3><p class="sub" id="ovDonutSub"></p><div class="chart short" id="ovDonut"></div></div>
      <div class="card"><h3>Pipeline created by adoption tier</h3><p class="sub" id="ovPipelineSub"></p><div class="chart short" id="ovPipeline"></div></div>
    </div>
  </div>
  <div class="watch" data-section="watch">
    <h3>What to watch</h3>
    <ul id="watch"></ul>
  </div>
  <div class="calc" id="calc" data-section="calculator">
    <div>
      <h3>Model the upside</h3>
      <p class="sub">What happens if a share of today's low-engagement deals were engaged to the medium level? Uses observed win rates for this account; deal value is editable.</p>
      <div class="calc-inputs">
        <label>Low-engagement deals lifted to medium: <b class="num" id="cPctL">10%</b><input type="range" id="cPct" min="1" max="50" value="10"></label>
        <label>Deal type<select id="cType"></select></label>
        <label>Average won deal value<input type="number" id="cVal" min="0" step="500"></label>
        <p class="sub" id="cValNote"></p>
      </div>
    </div>
    <div class="calc-out" aria-live="polite">
      <div style="font-size:14px;color:var(--mast-sub)">Estimated incremental bookings per year</div>
      <div class="big" id="cBig">–</div>
      <div class="row" style="margin-top:16px"><span>Low-engagement deals per year</span><span id="cN">–</span></div>
      <div class="row"><span>Deals lifted</span><span id="cLift">–</span></div>
      <div class="row"><span>Win rate, low → medium</span><span id="cWR">–</span></div>
      <div class="row"><span>Incremental wins per year</span><span id="cWins">–</span></div>
      <p>A directional model, not a forecast. It assumes lifted deals take on the medium-engagement win rate observed in this data.</p>
    </div>
  </div>
</div></section>

<section class="panel" id="p-activity"><div class="wrap">
  <div class="section-lbl">Activity trends</div>
  <h2>What reps do, averaged per rep per month</h2>
  <p class="intro">Each rep's monthly value is averaged across the window, then averaged across reps. Pick a metric, a population and the baseline and observation windows.</p>
  <div class="dyn callout" id="leadDyn"></div>
  <div class="controls"><div class="ctl"><span>Metric</span><div class="chips" id="leadMetric"></div></div></div>
  <div class="controls">
    <div class="ctl"><span>Population</span><select id="leadPop">
      <option value="all">All reps</option><option value="User">Backstory users</option><option value="Non-user">Non-users</option>
      <option value="High">High adopters</option><option value="Medium">Medium adopters</option><option value="Low">Low adopters</option></select></div>
    <div class="ctl"><span>Compare</span><div class="seg" id="leadMode">
      <button type="button" aria-pressed="true" data-v="pp">Last 6 vs prior 6</button><button type="button" aria-pressed="false" data-v="yoy">Last 6 vs same 6 last year</button><button type="button" aria-pressed="false" data-v="y12">Last 12 vs prior 12</button><button type="button" aria-pressed="false" data-v="q">Last quarter vs prior</button><button type="button" aria-pressed="false" data-v="custom">Custom</button></div></div>
    <div class="custom" id="leadCustom">
      <div class="ctl"><span>Baseline from</span><select id="bS"></select></div>
      <div class="ctl"><span>to</span><select id="bE"></select></div>
      <div class="ctl"><span>Observation from</span><select id="oS"></select></div>
      <div class="ctl"><span>to</span><select id="oE"></select></div>
    </div>
  </div>
  <div data-section="leadTrend" class="block">
    <div><h3 id="leadTitle">Monthly trend</h3><p class="sub">Shaded bands mark the baseline (grey) and observation (blue) windows.</p><div class="chart" id="leadTrend"></div></div>
    ${aside('What this shows', notes.lead)}
  </div>
  <div data-section="activityPeriod" class="block" id="periodBlock">
    <div><h3>Period comparison</h3><p class="sub" id="periodSub"></p><div class="chart" id="periodChart"></div></div>
    <aside class="note"><h4>Biggest moves</h4><p id="periodNote"></p></aside>
  </div>
  <div data-section="leadTable" class="block full">
    <div><h3>Baseline vs observation, all metrics</h3><p class="sub" id="leadTblSub"></p>
    <div class="tbl-wrap"><table id="leadTbl"></table></div></div>
  </div>
  <div data-section="activityMix" class="block" id="mixBlock">
    <div><h3>How the activity is made up</h3>
      <div class="controls" style="margin-top:10px"><div class="seg" id="mixKind"><button type="button" aria-pressed="true" data-v="meetings">Meetings by channel</button><button type="button" aria-pressed="false" data-v="emails">Emails by direction</button></div></div>
      <div class="chart" id="mixChart"></div></div>
    <aside class="note"><h4>Reading this</h4><p id="mixNote"></p></aside>
  </div>
  <div data-section="seniorMix" class="block" id="seniorBlock">
    <div><h3>Senior engagement, three periods</h3><p class="sub">Director, VP and executive meetings per rep per month: the same window a year earlier, the baseline, and the observation window.</p><div class="chart" id="seniorChart"></div></div>
    ${aside('What this shows', notes.mix)}
  </div>
</div></section>

<section class="panel" id="p-adoption"><div class="wrap">
  <div class="section-lbl">Adoption impact</div>
  <h2>What Backstory adopters do differently</h2>
  <p class="intro" id="adoptionIntro"></p>
  <div class="controls">
    <div class="ctl"><span>View</span><div class="seg" id="adoptView"><button type="button" aria-pressed="true" data-v="tiers">High, medium and low tiers</button><button type="button" aria-pressed="false" data-v="users">Users vs non-users</button></div></div>
    <div class="ctl"><span>Window</span><div class="seg" id="adoptWin"><button type="button" aria-pressed="true" data-v="obs">Last 6 months</button><button type="button" aria-pressed="false" data-v="l12">Last 12 months</button></div></div>
  </div>
  <div id="tiersView">
    <div class="tiles static" id="adoptKpis" data-section="adoptKpis"></div>
    <div data-section="adoptIndex" class="block">
      <div><h3>Engagement indexed to low adopters</h3><p class="sub">Low adopters = 100. Bars above 100 mean more activity per rep per month.</p><div class="chart" id="adoptIndex"></div></div>
      ${aside('What this shows', notes.adopt)}
    </div>
    <div class="cards3">
      <div class="card" data-section="cohortSenior"><h3>Senior engagement by tier</h3><p class="sub">Director, VP and executive meetings per rep per month.</p><div class="chart short" id="adoptSenior"></div></div>
      <div class="card" data-section="cohortPipeline"><h3>Pipeline created by tier</h3><p class="sub">Per rep per month.</p><div class="chart short" id="adoptPipeline"></div></div>
      <div class="card" data-section="cohortDonut"><h3>Cohort composition</h3><p class="sub">Reps in each tier. Select a slice to filter the roster.</p><div class="chart short" id="adoptDonut"></div></div>
    </div>
    <div data-section="adoptTrend" class="block full">
      <div><h3>The tier gap over time</h3>
        <div class="controls" style="margin-top:10px"><div class="ctl"><span>Metric</span><select id="adoptTrendMetric"></select></div></div>
        <div class="chart" id="adoptTrend"></div></div>
    </div>
    <div data-section="adoptTable" class="block full">
      <div><h3>Per-rep monthly averages by tier</h3><p class="sub" id="adoptTblSub"></p>
      <div class="tbl-wrap"><table id="adoptTbl"></table></div></div>
    </div>
  </div>
  <div id="usersView" class="hidden">
    <div class="tiles static" id="usersKpis" data-section="usersKpis"></div>
    <div data-section="usersLift" class="block">
      <div><h3>How much more users do, per rep per month</h3><p class="sub">Percent difference, users vs non-users.</p><div class="chart" id="usersLift"></div></div>
      ${aside('What this shows', notes.users)}
    </div>
    <div class="cards2">
      <div class="card" data-section="cohortSenior"><h3>Senior engagement, users vs non-users</h3><p class="sub">Director, VP and executive meetings per rep per month.</p><div class="chart short" id="usersSenior"></div></div>
      <div class="card" data-section="cohortPipeline"><h3>Pipeline created, users vs non-users</h3><p class="sub">Per rep per month.</p><div class="chart short" id="usersPipeline"></div></div>
    </div>
    <div data-section="usersTrend" class="block">
      <div><h3 id="usersTrendTitle">The senior-meeting gap over time</h3>
        <div class="controls" style="margin-top:10px"><div class="ctl"><span>Metric</span><select id="usersTrendMetric"></select></div></div>
        <p class="sub">Users are defined by current usage, so a gap before the usage window shows these reps were already more engaged.</p><div class="chart" id="usersTrend"></div></div>
      ${aside('Reading this fairly', notes.usersTrend)}
    </div>
    <div data-section="usersTable" class="block full">
      <div><h3>Per-rep monthly averages</h3><div class="tbl-wrap"><table id="usersTbl"></table></div></div>
    </div>
  </div>
  <div data-section="roster" class="block full" id="rosterBlock">
    <div>
      <div class="tbl-head"><div><h3>User roster</h3><p class="sub" id="rosterSub"></p></div>
        <div class="controls tight">
          <div class="chips" id="rosterTier"></div>
          <label class="search"><span class="sr">Search the roster</span><input type="search" id="rosterQ" placeholder="Search name, team or title"></label>
        </div></div>
      <div class="tbl-wrap tall"><table id="rosterTbl"></table></div>
      <p class="sub right" id="rosterCount"></p>
    </div>
  </div>
</div></section>

<section class="panel" id="p-deals"><div class="wrap">
  <div class="section-lbl">Deal engagement</div>
  <h2>Engagement against win rate and velocity</h2>
  <p class="intro">Every closed deal with a Backstory engagement score. Deals that closed within seven days of creation are booked-on-creation orders that win almost every time; they are excluded by default so they don't mask the relationship.</p>
  <div class="controls">
    <div class="ctl"><span>Group by</span><div class="seg" id="dealView"><button type="button" aria-pressed="true" data-v="deciles">Engagement deciles</button><button type="button" aria-pressed="false" data-v="levels">Engagement levels</button></div></div>
    <div class="ctl"><span>Deal type</span><select id="dealType"></select></div>
    <div class="ctl" id="dealModeWrap"><span>View</span><div class="seg" id="dealMode"><button type="button" aria-pressed="true" data-v="overall">Overall</button><button type="button" aria-pressed="false" data-v="monthly">Monthly trend</button><button type="button" aria-pressed="false" data-v="fy">By fiscal year</button></div></div>
    <label class="toggle" id="dealInclWrap"><input type="checkbox" id="dealIncl"> Include transactional deals (closed in 7 days or less)</label>
  </div>
  <div class="dyn callout" id="dealDyn"></div>
  <div class="tiles static" id="dealKpis" data-section="dealKpis"></div>
  <div class="yoy" id="dealYoy" data-section="dealFindings"></div>
  <div data-section="dealWin" class="block">
    <div><h3 id="dealWinTitle">Win rate</h3><p class="sub" id="dealWinSub">Bars show win rate; hover for deal counts and score range.</p><div class="chart" id="dealWin"></div></div>
    <aside class="note"><h4>What this shows</h4><div id="dealWinNote"></div></aside>
  </div>
  <div data-section="dealVel" class="block" id="dealVelBlock">
    <div><h3 id="dealVelTitle">Deal velocity</h3><p class="sub" id="dealVelSub">Median days from creation to close, for won and lost deals.</p><div class="chart" id="dealVel"></div></div>
    ${aside('What this shows', notes.dealVel)}
  </div>
  <div data-section="dealVolume" class="block full" id="dealVolBlock">
    <div><h3>Deal volume by engagement level</h3><p class="sub" id="dealVolSub"></p><div class="chart short" id="dealVol"></div></div>
  </div>
  <div id="accDealsWrap">
    <h3 class="section-h">Account-level view</h3>
    <p class="intro" id="accIntro"></p>
    <div data-section="accountDeals" class="block">
      <div><h3>Account win rate against engagement</h3><p class="sub">Accounts with two or more closed non-renewal deals. Bubble size is deal count; colour is the engagement level.</p><div class="chart tall" id="accBubble"></div></div>
      ${aside('What this shows', notes.accountDeals)}
    </div>
    <div data-section="accountTable" class="block full">
      <div><div class="tbl-head"><div><h3>Account detail</h3><p class="sub">Depth is activities per deal; breadth is how many personas were engaged across the account's deals.</p></div>
        <label class="search"><span class="sr">Search accounts</span><input type="search" id="accQ" placeholder="Search accounts"></label></div>
        <div class="tbl-wrap tall"><table id="accTbl"></table></div></div>
    </div>
  </div>
</div></section>

<section class="panel" id="p-stage"><div class="wrap">
  <div class="section-lbl">Stage and persona</div>
  <h2>Where engagement happens, and who moves the deal</h2>
  <p class="intro" id="stageIntro"></p>
  <div class="tiles static" id="stageKpis" data-section="stageKpis"></div>
  <div class="yoy" id="stageYoy" data-section="stageFindings"></div>
  <div data-section="stageHeat" class="block" id="heatBlock">
    <div><h3 id="heatTitle">Persona mix by stage</h3>
      <div class="controls" style="margin-top:10px"><div class="seg" id="heatMode"><button type="button" aria-pressed="true" data-v="share">Share of activity</button><button type="button" aria-pressed="false" data-v="won">Won deals</button><button type="button" aria-pressed="false" data-v="lost">Lost deals</button><button type="button" aria-pressed="false" data-v="diff">Won − lost</button><button type="button" aria-pressed="false" data-v="wr">Win rate when present</button></div></div>
      <p class="sub" id="heatSub"></p><div class="chart tall" id="stageHeat"></div></div>
    ${aside('What this shows', notes.stageHeat)}
  </div>
  <div data-section="stageWin" class="block" id="stageWinBlock">
    <div><h3>Win rate by stage</h3><p class="sub">Deals with activity logged at each stage, and how many of them were won. Each line is a fiscal year.</p><div class="chart" id="stageWin"></div></div>
    <aside class="note"><h4>Reading this</h4><p id="stageWinNote"></p></aside>
  </div>
  <div data-section="stageProf" class="block">
    <div><h3>Engagement by stage at time of activity</h3>
      <div class="controls" style="margin-top:10px"><div class="seg" id="stageView"><button type="button" aria-pressed="true" data-v="share">Share of activity</button><button type="button" aria-pressed="false" data-v="wl">Activity per deal, won vs lost</button><button type="button" aria-pressed="false" data-v="type">Channel mix</button><button type="button" aria-pressed="false" data-v="pwl">Personas, won vs lost</button><button type="button" aria-pressed="false" data-v="mixwon">Persona mix, won</button></div></div>
      <p class="sub" id="stageProfSub"></p><div class="chart" id="stageProf"></div></div>
    ${aside('What this shows', notes.stageProf)}
  </div>
  <div data-section="stageSurv" class="block">
    <div><h3>Early engagement and win rate among deals that reached late stage</h3>
      <p class="sub">Only deals with activity in the late stages. Compares those that also had the persona engaged in the early stages with those that didn't.</p>
      <div class="chart tall" id="stageSurv"></div></div>
    ${aside('What this shows', notes.stageSurv)}
  </div>
  <div data-section="stagePersona" class="block">
    <div><h3>Persona involvement, all pre-decision activity</h3>
      <div class="controls" style="margin-top:10px"><div class="seg" id="persView"><button type="button" aria-pressed="true" data-v="wr">Win rate with vs without</button><button type="button" aria-pressed="false" data-v="share">Share of won deals</button><button type="button" aria-pressed="false" data-v="days">Days to close (won)</button></div></div>
      <div class="chart tall" id="stagePers"></div></div>
    <aside class="note"><h4>What this shows</h4><p id="persNote"></p></aside>
  </div>
  <div data-section="stageBreadth" class="block">
    <div class="twocol">
      <div><h3>Buying-committee breadth</h3><p class="sub">Number of distinct personas engaged before a decision.</p><div class="chart short" id="stageBreadth"></div></div>
      <div><h3>Early activity intensity</h3><p class="sub">Quintiles of activity logged in the early stages.</p><div class="chart short" id="stageEarlyQ"></div></div>
    </div>
    ${aside('What this shows', notes.breadth)}
  </div>
</div></section>

<section class="panel" id="p-accounts"><div class="wrap">
  <div class="section-lbl">Account engagement</div>
  <h2>Which accounts the team works, and what they carry</h2>
  <div id="a360Wrap">
    <p class="intro" id="a360Intro"></p>
    <div class="controls"><div class="ctl"><span>Months</span><div class="seg" id="a360Range"></div></div><span class="sub" id="a360RangeLabel"></span></div>
    <div class="quads" id="a360Quads"></div>
    <div class="tiles static" id="a360Kpis" data-section="a360Kpis"></div>
    <div data-section="a360Cohorts" class="block">
      <div><h3>Pipeline per account, by Account 360 cohort</h3><p class="sub">Average pipeline created and closed-won per account in the months selected.</p><div class="chart" id="a360Cohorts"></div></div>
      <aside class="note"><h4>What this shows</h4>${paragraphs(notes.accounts)}<p id="a360Nuance"></p></aside>
    </div>
    <div data-section="a360Scatter" class="block full">
      <div><h3>Sessions against pipeline, per account</h3><p class="sub">Each dot is an account; the dashed line is the sessions cut-off. Pipeline on a log scale.</p><div class="chart tall" id="a360Scatter"></div></div>
    </div>
    <div data-section="a360Trend" class="block full">
      <div><h3>Pipeline by month</h3>
        <div class="controls" style="margin-top:10px"><div class="seg" id="a360TrendView"><button type="button" aria-pressed="true" data-v="total">Created and closed-won</button><button type="button" aria-pressed="false" data-v="cohort">Created, by cohort</button></div></div>
        <p class="sub" id="a360TrendSub"></p><div class="chart" id="a360Trend"></div></div>
    </div>
    <div data-section="a360Table" class="block full">
      <div class="twocol">
        <div><h3>Pipeline with little engagement</h3><p class="sub">Accounts carrying pipeline with few sessions, and accounts with none at all — where engagement is the gap.</p><div class="tbl-wrap"><table id="a360Watch"></table></div></div>
        <div><h3>Who drives the engagement</h3><p class="sub" id="a360UsersSub"></p><div class="tbl-wrap"><table id="a360Users"></table></div></div>
      </div>
    </div>
    <div data-section="a360Table" class="block full">
      <div><div class="tbl-head"><div><h3>Every account</h3><p class="sub">Select a column to sort.</p></div>
        <div class="controls tight"><select id="a360Cohort" aria-label="Cohort"></select><label class="search"><span class="sr">Search accounts</span><input type="search" id="a360Q" placeholder="Search accounts"></label></div></div>
        <div class="tbl-wrap tall"><table id="a360Tbl"></table></div></div>
    </div>
  </div>
</div></section>

<section class="panel" id="p-method"><div class="wrap method">
  <div class="section-lbl">Method</div>
  <h2>Method and caveats</h2>
  <h3>This analysis</h3>
  <ul>
    ${reason ? `<li>Run for: ${escapeHtml(reason)}.</li>` : ''}
    ${configLines.map((line) => `<li>${escapeHtml(line)}.</li>`).join('')}
    ${windows ? `<li>Observation window ${escapeHtml(windows.observationLabel)}; baseline ${escapeHtml(windows.baselineLabel)}${windows.yearAgoLabel ? `; the same window a year earlier ${escapeHtml(windows.yearAgoLabel)}` : ''}. Windows count back from the newest month in the activity extract unless explicit months were chosen.</li>` : ''}
    <li>${config.fiscalYearStartMonth ? `Fiscal years start in ${MONTH_NAMES[config.fiscalYearStartMonth - 1]} and are named for the calendar year they end in.` : 'No fiscal year start was set, so fiscal years are calendar years.'}</li>
  </ul>
${facts.AGG ? `  <h3>Where the numbers come from</h3>
  <ul>
    <li>Source: ${escapeHtml(account)}'s value readout. It carries monthly averages per rep for the whole team, each adoption cohort and each role; a roster of ${facts.AGG ? facts.AGG.roster.length : 0} people; deal outcomes by month, fiscal year, decile and opportunity type; stage and persona tables; and deal engagement per account.</li>
    <li>Team views use the readout's team averages, cohort views its cohort averages; with a role filter, the team views use its role averages. The roster shows the readout's totals for the last six months.</li>
    <li>Adoption cohorts are the readout's: high, medium and low adopters by Backstory usage, and non-users.</li>
    <li>Deals: every closed deal with an engagement score, all opportunity types by default. Levels: Low 0 – 30, Medium 31 – 70, High 71+; deciles are the readout's. Velocity is the average days from creation to close across won and lost deals.</li>
    <li>Stage and persona: win rate for deals with activity at each stage. Persona figures are activities per deal on won and lost deals; the heatmap's win rate is the share of deals with the persona engaged at the stage that were won.</li>
  </ul>
` : `  <h3>Activity trends</h3>
  <ul>
    <li>Source: the activity extract, one row per rep per month, up to 24 months.</li>
    <li>Metrics: meetings, emails sent, Director + VP + Executive meetings, VP meetings, Executive meetings, people engaged (external people touched), pipeline created (touched) and pipeline created (owned).</li>
    <li>Per-rep averaging: each rep's monthly values are averaged across the months they appear in the window; those rep averages are then averaged.</li>
    <li>Pipeline cleaning: reps whose pipeline is reported in another currency (median rep-month more than 25× the org's) are excluded from pipeline metrics only. Remaining rep-months are capped at the 95th percentile of non-zero values (<span class="num" id="capP"></span> touched, <span class="num" id="capPO"></span> owned).</li>
    <li>Roles are grouped from each rep's CRM role or team on a best-effort basis; "Other" holds those that name no role.</li>
  </ul>
  <h3>Adoption impact</h3>
  <ul id="methodUsage"></ul>
  <h3>Deal engagement, stage and persona</h3>
  <ul>
    <li>Source: closed deals with an engagement score. Framework deals excluded; the default view excludes renewals.</li>
    <li>Transactional deals (open 7 days or less) are excluded by default and can be toggled back in when cycle times are available.</li>
    <li>Levels: Low 0 – 30, Medium 31 – 70, High 71+. Deciles use equal-count bins of the engagement score, recomputed for whatever the filters select. Velocity is the median days from creation to close.</li>
    <li>Stage and persona: closed non-renewal deals by stage (<span class="num" id="mOpps"></span> opportunities). Cycle time joined from the opportunity file on CRM id (<span id="mCycle"></span>). Win-rate analysis of personas uses only activity logged in pre-decision stages and excludes transactional deals (<span class="num" id="mPre"></span> opportunities, <span class="num" id="mPreWR"></span> win rate).</li>
    <li>The stage × persona heatmap counts each deal once per stage it had activity in: averages are that persona's activities per deal at the stage; "win rate when present" is the share of deals with the persona at that stage that were won. Post-decision stages are shown, but activity there happens after the outcome is known.</li>
    <li>Survivorship control: comparing early vs late engagement across all deals is misleading because deals lost early never generate late activity. The early-engagement chart restricts to deals that reached <span id="mLateStages"></span> (<span class="num" id="mLate"></span> deals); "early" means <span id="mEarly"></span>.</li>
  </ul>
  <h3>Account engagement</h3>
  <ul id="methodA360"></ul>
`}  <h3>Data notes for this run</h3>
  <ul>${caveats.length ? caveats.map((caveat) => `<li>${inline(caveat)}</li>`).join('') : '<li>No data issues were reported.</li>'}</ul>
  <h3>What this analysis doesn't claim</h3>
  <ul>
    <li>All relationships are correlations. Usage cohorts are self-selected, and any users-vs-non-users gap may predate the usage window.</li>
    <li>Pipeline and bookings aren't normalised for quota, territory or role mix.</li>
    <li>The upside model uses median won deal value by default because amounts are heavily skewed; the P95-capped mean is shown for comparison.</li>
  </ul>
</div></section>
</main>
<footer><div class="wrap">Backstory value readout for ${escapeHtml(account)}${generatedLabel ? ` · ${escapeHtml(generatedLabel)}` : ''} · prepared with Backstory activity and opportunity data · computed by the ROI Analyst</div></footer>

<script>
const U = ${scriptJson(facts.U)};
const OPP = ${scriptJson(facts.OPP)};
const DEALS = ${scriptJson(facts.DEALS ?? null)};
const ST = ${scriptJson(facts.ST)};
const ACC = ${scriptJson(facts.ACC ?? null)};
const META = ${scriptJson(facts.META ?? {})};
const A360 = ${scriptJson(a360)};
const AGG = ${scriptJson(facts.AGG ?? null)};
const N = ${scriptJson(normalized)};
const CFG = ${scriptJson(runConfig)};
const VIEW = ${scriptJson({ hiddenTabs: view.hiddenTabs })};
</script>
<script>${REPORT_SCRIPT}</script>
</body>
</html>`
}
