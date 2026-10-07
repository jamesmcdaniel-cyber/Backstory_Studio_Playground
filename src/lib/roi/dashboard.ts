import { LEGACY_TAB, type RoiNarrative } from './contract'
import type { RoiFacts } from './prep'
import type { Account360Facts } from './account360/prep'
import { EMPTY_VIEW, type RoiView } from './view'
import { configFromPreset, describeRunConfig, MONTH_NAMES, resolveWindows, type RoiRunConfig } from './config'
import { encodeMatrix } from './facts'
import { REPORT_CSS } from './report-css'
import { REPORT_SCRIPT } from './report-script'

/**
 * The ROI report — the Iron Mountain dashboard, generic across customers,
 * with Backstory's value-readout views added in place.
 *
 * Structure, styles and chart code are the Iron Mountain page's own (Plotly,
 * its tabs, a "What this shows" aside beside every chart, the upside
 * calculator, the Method tab):
 *
 *   Summary · Leading indicators · Adoption tiers · Users vs non-users ·
 *   Deal engagement · Stage and persona · Account engagement · Method
 *
 * Inside them, each value-readout element appears once: headline numbers in
 * the masthead; meeting channel and email direction, and senior engagement
 * over three periods (leading indicators); cohort comparisons, senior
 * engagement and pipeline by cohort, composition and the user roster
 * (adoption tiers, users); deal outcomes by month and fiscal year with
 * year-over-year findings (deal engagement); the stage × persona heatmap,
 * win rate by stage and persona lines (stage and persona); and the Account 360
 * cohorts with deal engagement per account (the one new tab). Fiscal year,
 * quarter and role filters sit in a side panel behind a menu button — the ROI
 * page hosts them in its own panel instead (see RoiReportFrame).
 *
 * The data objects come from the preps (U, OPP, DEALS, ST, ACC, META, and the
 * Account 360 bundle), the prose from the analyst's narrative, the windows
 * from the run's configuration. Sections whose data is missing are left out.
 * Plotly loads from /vendor because the frame's CSP allows nothing off our
 * origin (fonts excepted).
 */

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
  const metaLine = [`ROI analysis for ${account}`, reason ? `Prepared for: ${reason}` : '', activityRange, dealCount ? `${Math.round(dealCount).toLocaleString()} closed deals` : '', generatedLabel ? `Generated ${generatedLabel}` : ''].filter(Boolean).join(' · ')
  const notes = narrative.notes
  const aside = (title: string, items: string[] | undefined, id?: string) => `<aside class="note"${id ? ` id="${id}"` : ''}><h4>${escapeHtml(title)}</h4>${paragraphs(items) || '<p class="muted">—</p>'}</aside>`
  const caveats = [...(narrative.caveats ?? []), ...(facts.notes ?? []), ...(a360?.notes ?? [])]
  // Narratives written for the seven-tab dashboard point at its tab ids.
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
  const configLines = describeRunConfig(config)
  const findingsWord = ['two', 'three', 'four', 'five', 'six'][normalized.findings.length - 2] ?? 'four'
  const context = normalized.context

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Backstory ROI analysis · ${escapeHtml(account)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cardo:wght@400;700&family=Chivo+Mono:wght@400;500;700&family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet">
<script src="/vendor/plotly.min.js"></script>
<style>${REPORT_CSS}${view.hiddenSections.map((section) => `[data-section="${section.replace(/[^a-zA-Z0-9]/g, '')}"]{display:none!important}`).join('')}</style>
</head>
<body>
<header class="mast">
  <div class="wrap">
    <button class="themebtn" id="themeBtn" type="button">Theme: auto</button>
    <div class="brand">
      <svg viewBox="0 0 22 18" aria-hidden="true"><rect x="0" y="2" width="4" height="16" fill="currentColor"/><rect x="6" y="0" width="4" height="18" fill="currentColor"/><rect x="12.5" y="3" width="4" height="15" transform="rotate(-12 14.5 10.5)" fill="currentColor"/></svg>
      Backstory
    </div>
    <div class="mast-meta">${escapeHtml(metaLine)}</div>
    <div class="mast-grid">
      <div>
        <h1>${escapeHtml(normalized.headline)}</h1>
        <p class="lede">${inline(normalized.lede)}</p>
      </div>
      <figure class="strip-wrap" data-section="hero">
        <div id="heroStrip" role="img" aria-label="Headline chart"></div>
        <figcaption id="heroCap">Win rate by engagement decile, lowest to highest (non-transactional deals, excluding renewals)</figcaption>
      </figure>
    </div>
    <div class="hero-stats" id="heroStats" data-section="heroStats"></div>
  </div>
</header>

<nav class="tabs" aria-label="Sections"><div class="wrap navrow">
  <button type="button" class="hamburger" id="filtersBtn" aria-label="Filters" aria-controls="filterPanel" aria-expanded="false"><span></span><span></span><span></span></button>
  <div class="tablist" role="tablist">
  <button role="tab" type="button" data-tab="summary" aria-selected="true">Summary</button>
  <button role="tab" type="button" data-tab="lead" aria-selected="false">Leading indicators</button>
  <button role="tab" type="button" data-tab="adopt" aria-selected="false">Adoption tiers</button>
  <button role="tab" type="button" data-tab="users" aria-selected="false">Users vs non-users</button>
  <button role="tab" type="button" data-tab="deal" aria-selected="false">Deal engagement</button>
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
  <h2>The ROI story in ${findingsWord} numbers</h2>
  <p class="intro">Each figure is traceable to a view in this dashboard. The chain runs from product usage, to rep behaviour, to deal engagement, to outcomes.</p>
  <div class="findings" id="findings" data-section="findings"></div>
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

<section class="panel" id="p-lead"><div class="wrap">
  <h2>Leading indicators, averaged per rep per month</h2>
  <p class="intro">Each rep's monthly value is averaged across the window, then averaged across reps. Pick a metric, a population and the baseline and observation windows.</p>
  <div class="controls"><div class="ctl"><span>Metric</span><div class="chips" id="leadMetric"></div></div></div>
  <div class="controls">
    <div class="ctl"><span>Population</span><select id="leadPop">
      <option value="all">All reps</option><option value="User">Backstory users</option><option value="Non-user">Non-users</option>
      <option value="High">High adopters</option><option value="Medium">Medium adopters</option><option value="Low">Low adopters</option></select></div>
    <div class="ctl"><span>Comparison</span><div class="seg" id="leadMode">
      <button type="button" aria-pressed="true" data-v="pp">Last 6 vs prior 6</button><button type="button" aria-pressed="false" data-v="yoy">Last 6 vs same 6 last year</button><button type="button" aria-pressed="false" data-v="y12">Last 12 vs prior 12</button><button type="button" aria-pressed="false" data-v="q">Last quarter vs prior</button><button type="button" aria-pressed="false" data-v="custom">Custom</button></div></div>
    <div class="custom" id="leadCustom">
      <div class="ctl"><span>Baseline from</span><select id="bS"></select></div>
      <div class="ctl"><span>to</span><select id="bE"></select></div>
      <div class="ctl"><span>Observation from</span><select id="oS"></select></div>
      <div class="ctl"><span>to</span><select id="oE"></select></div>
    </div>
  </div>
  <div class="dyn" id="leadDyn"></div>
  <div data-section="leadTrend" class="block">
    <div><h3 id="leadTitle">Monthly trend</h3><p class="sub">Shaded bands mark the baseline (grey) and observation (blue) windows.</p><div class="chart" id="leadTrend"></div></div>
    ${aside('What this shows', notes.lead)}
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

<section class="panel" id="p-adopt"><div class="wrap">
  <h2>High, medium and low adopters</h2>
  <p class="intro" id="adoptIntro"></p>
  <div class="controls"><div class="ctl"><span>Window</span><div class="seg" id="adoptWin"><button type="button" aria-pressed="true" data-v="obs">Last 6 months</button><button type="button" aria-pressed="false" data-v="l12">Last 12 months</button></div></div></div>
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

<section class="panel" id="p-users"><div class="wrap">
  <h2>Backstory users vs non-users</h2>
  <p class="intro" id="usersIntro"></p>
  <div class="controls"><div class="ctl"><span>Window</span><div class="seg" id="usersWin"><button type="button" aria-pressed="true" data-v="obs">Last 6 months</button><button type="button" aria-pressed="false" data-v="l12">Last 12 months</button></div></div></div>
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
</div></section>

<section class="panel" id="p-deal"><div class="wrap">
  <h2>Deal engagement vs win rate and velocity</h2>
  <p class="intro">Every closed deal with a Backstory engagement score. Deals that closed within seven days of creation are booked-on-creation orders that win almost every time; they are excluded by default so they don't mask the relationship.</p>
  <div class="controls">
    <div class="ctl"><span>Group by</span><div class="seg" id="dealView"><button type="button" aria-pressed="true" data-v="deciles">Engagement deciles</button><button type="button" aria-pressed="false" data-v="levels">Engagement levels</button></div></div>
    <div class="ctl"><span>Deal type</span><select id="dealType"></select></div>
    <div class="ctl" id="dealModeWrap"><span>View</span><div class="seg" id="dealMode"><button type="button" aria-pressed="true" data-v="overall">Overall</button><button type="button" aria-pressed="false" data-v="monthly">Monthly trend</button><button type="button" aria-pressed="false" data-v="fy">By fiscal year</button></div></div>
    <label class="toggle" id="dealInclWrap"><input type="checkbox" id="dealIncl"> Include transactional deals (closed in 7 days or less)</label>
  </div>
  <div class="dyn" id="dealDyn"></div>
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
</div></section>

<section class="panel" id="p-stage"><div class="wrap">
  <h2>Where engagement happens, and who moves the deal</h2>
  <p class="intro" id="stageIntro"></p>
  <div class="tiles static" id="stageKpis" data-section="stageKpis"></div>
  <div class="yoy" id="stageYoy" data-section="stageFindings"></div>
  <div data-section="stageProf" class="block">
    <div><h3>Engagement by stage at time of activity</h3>
      <div class="controls" style="margin-top:10px"><div class="seg" id="stageView"><button type="button" aria-pressed="true" data-v="share">Share of activity</button><button type="button" aria-pressed="false" data-v="wl">Activity per deal, won vs lost</button><button type="button" aria-pressed="false" data-v="type">Channel mix</button><button type="button" aria-pressed="false" data-v="pwl">Personas, won vs lost</button><button type="button" aria-pressed="false" data-v="mixwon">Persona mix, won</button></div></div>
      <p class="sub" id="stageProfSub"></p><div class="chart" id="stageProf"></div></div>
    ${aside('What this shows', notes.stageProf)}
  </div>
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
  <div id="accDealsWrap">
    <h3 class="section-h">Deal engagement by account</h3>
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

<section class="panel" id="p-method"><div class="wrap method">
  <h2>Method and caveats</h2>
  <h3>This analysis</h3>
  <ul>
    ${reason ? `<li>Run for: ${escapeHtml(reason)}.</li>` : ''}
    ${configLines.map((line) => `<li>${escapeHtml(line)}.</li>`).join('')}
    ${windows ? `<li>Observation window ${escapeHtml(windows.observationLabel)}; baseline ${escapeHtml(windows.baselineLabel)}${windows.yearAgoLabel ? `; the same window a year earlier ${escapeHtml(windows.yearAgoLabel)}` : ''}. Windows count back from the newest month in the activity extract unless explicit months were chosen.</li>` : ''}
    <li>${config.fiscalYearStartMonth ? `Fiscal years start in ${MONTH_NAMES[config.fiscalYearStartMonth - 1]} and are named for the calendar year they end in.` : 'No fiscal year start was set, so fiscal years are calendar years.'}</li>
  </ul>
  <h3>Activity trends</h3>
  <ul>
    <li>Source: the activity extract, one row per rep per month, up to 24 months.</li>
    <li>Metrics: meetings, emails sent, Director + VP + Executive meetings, VP meetings, Executive meetings, people engaged (external people touched), pipeline created (touched) and pipeline created (owned).</li>
    <li>Per-rep averaging: each rep's monthly values are averaged across the months they appear in the window; those rep averages are then averaged.</li>
    <li>Pipeline cleaning: reps whose pipeline is reported in another currency (median rep-month more than 25× the org's) are excluded from pipeline metrics only. Remaining rep-months are capped at the 95th percentile of non-zero values (<span class="num" id="capP"></span> touched, <span class="num" id="capPO"></span> owned).</li>
    <li>Roles are grouped from each rep's CRM role or team on a best-effort basis; "Other" holds those that name no role.</li>
  </ul>
  <h3>Adoption impact</h3>
  <ul id="methodUsage"></ul>
  <h3>Deal intelligence</h3>
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
  <h3>Data notes for this run</h3>
  <ul>${caveats.length ? caveats.map((caveat) => `<li>${inline(caveat)}</li>`).join('') : '<li>No data issues were reported.</li>'}</ul>
  <h3>What this analysis doesn't claim</h3>
  <ul>
    <li>All relationships are correlations. Usage cohorts are self-selected, and any users-vs-non-users gap may predate the usage window.</li>
    <li>Pipeline and bookings aren't normalised for quota, territory or role mix.</li>
    <li>The upside model uses median won deal value by default because amounts are heavily skewed; the P95-capped mean is shown for comparison.</li>
  </ul>
</div></section>
</main>
<footer><div class="wrap">Prepared with Backstory activity and opportunity data for ${escapeHtml(account)}${generatedLabel ? ` · ${escapeHtml(generatedLabel)}` : ''} · computed by the ROI Analyst</div></footer>

<script>
const U = ${scriptJson(facts.U)};
const OPP = ${scriptJson(facts.OPP)};
const DEALS = ${scriptJson(facts.DEALS ?? null)};
const ST = ${scriptJson(facts.ST)};
const ACC = ${scriptJson(facts.ACC ?? null)};
const META = ${scriptJson(facts.META ?? {})};
const A360 = ${scriptJson(a360)};
const N = ${scriptJson(normalized)};
const CFG = ${scriptJson(runConfig)};
const VIEW = ${scriptJson({ hiddenTabs: view.hiddenTabs })};
</script>
<script>${REPORT_SCRIPT}</script>
</body>
</html>`
}
