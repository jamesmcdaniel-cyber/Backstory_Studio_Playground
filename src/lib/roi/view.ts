import { z } from 'zod'
import { findingSchema, ROI_NOTE_KEYS, type RoiNarrative } from './contract'
import { isRoiTimeframePreset, type RoiTimeframePreset } from './timeframe'

/**
 * How an ROI dashboard is shown — separate from what it says (the facts)
 * and how it is told (the narrative). Asking the assistant to "drop the
 * adoption tab", "rename pipeline to bookings pipeline" or "add accounts
 * touched" edits this, not the HTML: the page is re-rendered from facts +
 * narrative + view, so a change can never corrupt the charts, and every
 * change is a new version with the old one kept.
 */

export const ROI_TABS = ['activity', 'adoption', 'deals', 'stage', 'accounts', 'method'] as const
export type RoiTab = (typeof ROI_TABS)[number]

/** The report's tabs (the Executive summary always shows), in Backstory's value-readout order. */
export const ROI_TAB_LABEL: Record<RoiTab, string> = {
  activity: 'Activity trends',
  adoption: 'Adoption impact',
  deals: 'Deal engagement',
  stage: 'Stage and persona',
  accounts: 'Account engagement',
  method: 'Method',
}

/**
 * Tab ids from earlier layouts. The Iron Mountain layout split adoption into
 * tiers and users (both now views of Adoption impact, so hiding "users" alone
 * hides nothing) and named the others lead and deal.
 */
const LEGACY_TABS: Record<string, RoiTab | null> = { lead: 'activity', adopt: 'adoption', users: null, deal: 'deals' }

/** Every block the report can show or hide, with what it is. */
export const ROI_SECTIONS = {
  hero: 'Executive summary: headline chart in the masthead',
  heroStats: 'Executive summary: the four headline numbers',
  context: 'Executive summary: account context from the Backstory platform',
  live: 'Executive summary: the account today, live from Backstory and Salesforce',
  findings: 'Executive summary: the findings cards',
  scorecard: 'Executive summary: the scorecard (observation vs baseline)',
  overview: 'Executive summary: adoption overview (cohorts and pipeline by tier)',
  watch: 'Executive summary: the "What to watch" list',
  calculator: 'Executive summary: the "Model the upside" calculator',
  leadTrend: 'Activity trends: monthly trend chart',
  activityPeriod: 'Activity trends: period comparison chart',
  leadTable: 'Activity trends: baseline vs observation table',
  activityMix: 'Activity trends: meetings by channel and emails by direction',
  seniorMix: 'Activity trends: senior engagement across three periods',
  adoptKpis: 'Adoption impact (tiers): headline comparisons',
  adoptIndex: 'Adoption impact (tiers): indexed chart',
  cohortSenior: 'Adoption impact: senior engagement by cohort',
  cohortPipeline: 'Adoption impact: pipeline by cohort',
  cohortDonut: 'Adoption impact (tiers): cohort composition',
  adoptTrend: 'Adoption impact (tiers): the tier gap over time',
  adoptTable: 'Adoption impact (tiers): per-rep averages table',
  roster: 'Adoption impact: user roster',
  usersKpis: 'Adoption impact (users): headline comparisons',
  usersLift: 'Adoption impact (users): lift chart',
  usersTrend: 'Adoption impact (users): the gap over time',
  usersTable: 'Adoption impact (users): per-rep averages table',
  dealKpis: 'Deal engagement: headline numbers',
  dealFindings: 'Deal engagement: year-over-year findings',
  dealWin: 'Deal engagement: win rate chart',
  dealVel: 'Deal engagement: velocity chart',
  dealVolume: 'Deal engagement: deal volume by engagement level',
  accountDeals: 'Deal engagement: account win rate vs engagement',
  accountTable: 'Deal engagement: account detail table',
  stageKpis: 'Stage and persona: win rate by stage numbers',
  stageFindings: 'Stage and persona: year-over-year findings',
  stageProf: 'Stage and persona: engagement by stage',
  stageHeat: 'Stage and persona: stage × persona heatmap',
  stageWin: 'Stage and persona: win rate by stage',
  stageSurv: 'Stage and persona: early vs late engagement',
  stagePersona: 'Stage and persona: persona involvement',
  stageBreadth: 'Stage and persona: committee breadth and early activity',
  a360Kpis: 'Account engagement: Account 360 cohort numbers',
  a360Cohorts: 'Account engagement: pipeline by Account 360 cohort',
  a360Scatter: 'Account engagement: sessions vs pipeline per account',
  a360Trend: 'Account engagement: pipeline trend by cohort',
  a360Table: 'Account engagement: Account 360 account tables',
} as const
export type RoiSection = keyof typeof ROI_SECTIONS

/** Every chart the report draws, by its element id, for set_chart. */
export const ROI_CHARTS = {
  heroStrip: 'Masthead: win rate by engagement decile, the headline chart',
  ovDonut: 'Executive summary: usage cohorts donut',
  ovPipeline: 'Executive summary: pipeline created by adoption tier',
  leadTrend: 'Activity trends: the monthly trend of the chosen metric',
  periodChart: 'Activity trends: period comparison, change per metric',
  mixChart: 'Activity trends: meetings by channel or emails by direction',
  seniorChart: 'Activity trends: senior engagement across three periods',
  adoptIndex: 'Adoption impact (tiers): engagement indexed to low adopters',
  adoptSenior: 'Adoption impact (tiers): senior engagement by tier',
  adoptPipeline: 'Adoption impact (tiers): pipeline created by tier',
  adoptDonut: 'Adoption impact (tiers): cohort composition donut',
  adoptTrend: 'Adoption impact (tiers): the tier gap over time',
  usersLift: 'Adoption impact (users): how much more users do',
  usersSenior: 'Adoption impact (users): senior engagement, users vs non-users',
  usersPipeline: 'Adoption impact (users): pipeline created, users vs non-users',
  usersTrend: 'Adoption impact (users): the gap over time',
  dealWin: 'Deal engagement: win rate by decile, level, month or fiscal year',
  dealVel: 'Deal engagement: deal velocity',
  dealVol: 'Deal engagement: deal volume by engagement level',
  accBubble: 'Deal engagement: account win rate against engagement (bubbles)',
  stageHeat: 'Stage and persona: the stage × persona heatmap',
  stageWin: 'Stage and persona: win rate by stage',
  stageProf: 'Stage and persona: engagement by stage at time of activity',
  stageSurv: 'Stage and persona: early engagement among deals that reached late stage',
  stagePers: 'Stage and persona: persona involvement',
  stageBreadth: 'Stage and persona: buying-committee breadth',
  stageEarlyQ: 'Stage and persona: early activity intensity',
  a360Cohorts: 'Account engagement: pipeline per account by Account 360 cohort',
  a360Scatter: 'Account engagement: sessions against pipeline per account',
  a360Trend: 'Account engagement: pipeline by month',
} as const
export type RoiChart = keyof typeof ROI_CHARTS

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colours are six-digit hex, like #2878C0.')

/** How one chart is drawn, over the report's defaults. */
export const chartOptionsSchema = z.object({
  kind: z.enum(['bar', 'line', 'area']).optional(),
  labels: z.boolean().optional(),
  height: z.enum(['short', 'normal', 'tall']).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  subtitle: z.string().trim().max(300).optional(),
  colors: z.array(hexColor).min(1).max(6).optional(),
})
export type RoiChartOptions = z.infer<typeof chartOptionsSchema>

export const ROI_CUSTOM_HTML_MAX = 20_000
export const ROI_CUSTOM_SECTIONS_MAX = 12

/** A block the assistant adds to a tab: its own HTML, drawn with the report's styles. */
export const customSectionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, 'Section ids are lower-case letters, digits and dashes.'),
  tab: z.enum(['summary', ...ROI_TABS] as ['summary', ...typeof ROI_TABS[number][]]),
  title: z.string().trim().min(1).max(120),
  html: z.string().min(1).max(ROI_CUSTOM_HTML_MAX),
  /** Where on the tab: before its first block, or after its last (the default). */
  position: z.enum(['start', 'end']).optional(),
})
export type RoiCustomSection = z.infer<typeof customSectionSchema>

/** The report's look, over the brand defaults. */
export const styleSchema = z.object({
  accent: hexColor.optional(),
  series: z.array(hexColor).min(1).max(6).optional(),
  density: z.enum(['comfortable', 'compact']).optional(),
  css: z.string().max(8_000).optional(),
})
export type RoiStyle = z.infer<typeof styleSchema>

/** Why a custom section's HTML is refused: the report's own script and sandbox stay the report's. */
export function unsafeCustomHtml(html: string): string | null {
  if (/<\s*(script|iframe|object|embed|link|meta|base|form)\b/i.test(html)) return 'A custom section is HTML and CSS only: no script, iframe, object, embed, link, meta, base or form tags.'
  if (/\bon[a-z]+\s*=/i.test(html)) return 'A custom section cannot carry inline event handlers (onclick and the like).'
  if (/javascript:/i.test(html)) return 'A custom section cannot use javascript: URLs.'
  return null
}

/** Why a style sheet is refused. */
export function unsafeCustomCss(css: string): string | null {
  if (/@import|<\/style|expression\s*\(|behavior\s*:/i.test(css)) return 'Custom CSS cannot import, close the style tag, or use expression() or behavior:.'
  return null
}

/** Section ids from the consolidated layout that became another block. */
const LEGACY_SECTIONS: Record<string, RoiSection> = { activityTiles: 'leadTable', cohortKpis: 'adoptKpis', cohortTable: 'adoptTable' }

const metricKey = z.string().regex(/^[a-z][a-z0-9_]{1,48}$/, 'Metric keys are lower_snake_case.')

export const extraMetricSchema = z.object({
  key: metricKey,
  label: z.string().trim().min(1).max(60),
  /** Activity-extract columns summed per rep per month. */
  columns: z.array(z.string().min(1).max(80)).min(1).max(8),
  format: z.enum(['count', 'currency']).default('count'),
})
export type RoiExtraMetric = z.infer<typeof extraMetricSchema>

export const roiViewSchema = z.object({
  hiddenTabs: z.array(z.string()).default([]).transform((tabs) => normalizeTabs(tabs)),
  hiddenSections: z.array(z.string()).default([]),
  hiddenMetrics: z.array(z.string()).default([]),
  metricLabels: z.record(z.string(), z.string().max(60)).default({}),
  extraMetrics: z.array(extraMetricSchema).max(12).default([]),
  defaultComparison: z.string().optional(),
  /** The look: accent, series colours, density, a style sheet. */
  style: styleSchema.optional(),
  /** Per-chart drawing options, keyed by chart id (ROI_CHARTS). */
  charts: z.record(z.string(), chartOptionsSchema).default({}),
  /** Blocks the assistant added, drawn on their tabs. */
  sections: z.array(customSectionSchema).max(ROI_CUSTOM_SECTIONS_MAX).default([]),
  /** Headings changed on the report's own sections, keyed by section id. */
  sectionTitles: z.record(z.string(), z.string().trim().min(1).max(120)).default({}),
})
export type RoiView = z.infer<typeof roiViewSchema>

function normalizeTabs(tabs: string[]): RoiTab[] {
  const hidden = new Set(tabs.map((tab) => (tab in LEGACY_TABS ? LEGACY_TABS[tab] : tab)))
  return ROI_TABS.filter((tab) => hidden.has(tab))
}

/** A tab named by today's id or an earlier layout's. */
const tabSchema = z.preprocess((value) => (typeof value === 'string' && LEGACY_TABS[value] ? LEGACY_TABS[value] : value), z.enum(ROI_TABS))

export const EMPTY_VIEW: RoiView = { hiddenTabs: [], hiddenSections: [], hiddenMetrics: [], metricLabels: {}, extraMetrics: [], charts: {}, sections: [], sectionTitles: {} }

export function readView(value: unknown): RoiView {
  const parsed = roiViewSchema.safeParse(value ?? {})
  if (!parsed.success) return { ...EMPTY_VIEW }
  return { ...parsed.data, hiddenSections: [...new Set(parsed.data.hiddenSections.map((section) => LEGACY_SECTIONS[section] ?? section))] }
}

/** One edit the assistant can make. A request becomes a list of these. */
export const roiOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('hide_tab'), tab: tabSchema }),
  z.object({ op: z.literal('show_tab'), tab: tabSchema }),
  z.object({ op: z.literal('hide_section'), section: z.string() }),
  z.object({ op: z.literal('show_section'), section: z.string() }),
  z.object({ op: z.literal('hide_metric'), metric: z.string() }),
  z.object({ op: z.literal('show_metric'), metric: z.string() }),
  z.object({ op: z.literal('rename_metric'), metric: z.string(), label: z.string().trim().min(1).max(60) }),
  z.object({ op: z.literal('add_metric'), metric: extraMetricSchema }),
  z.object({ op: z.literal('remove_added_metric'), metric: z.string() }),
  z.object({ op: z.literal('set_default_comparison'), preset: z.string() }),
  z.object({ op: z.literal('set_headline'), text: z.string().trim().min(10).max(240) }),
  z.object({ op: z.literal('set_lede'), text: z.string().trim().min(10).max(1_200) }),
  z.object({ op: z.literal('remove_finding'), index: z.number().int().min(0) }),
  z.object({
    op: z.literal('upsert_finding'),
    index: z.number().int().min(0).optional(),
    finding: findingSchema,
  }),
  z.object({ op: z.literal('remove_watch_item'), index: z.number().int().min(0) }),
  z.object({ op: z.literal('upsert_watch_item'), index: z.number().int().min(0).optional(), item: z.object({ lead: z.string().min(1).max(160), text: z.string().min(1).max(1_200) }) }),
  z.object({ op: z.literal('set_note'), note: z.enum(ROI_NOTE_KEYS), paragraphs: z.array(z.string().min(1).max(2_000)).min(1).max(4) }),
  z.object({ op: z.literal('add_caveat'), text: z.string().min(1).max(800) }),
  z.object({ op: z.literal('set_style'), style: styleSchema }),
  z.object({ op: z.literal('reset_style') }),
  z.object({ op: z.literal('set_chart'), chart: z.string(), options: chartOptionsSchema }),
  z.object({ op: z.literal('reset_chart'), chart: z.string() }),
  z.object({ op: z.literal('add_section'), customSection: customSectionSchema }),
  z.object({ op: z.literal('remove_section'), id: z.string() }),
  z.object({ op: z.literal('set_section_title'), section: z.string(), title: z.string().trim().min(1).max(120) }),
])
export type RoiOperation = z.infer<typeof roiOperationSchema>

export type ApplyContext = {
  /** Metric keys the current facts carry (built-in + added). */
  metricKeys: string[]
  /** Numeric columns of the activity extract, for add_metric. */
  activityColumns: string[]
}

export type ApplyResult = {
  view: RoiView
  narrative: RoiNarrative
  /** True when facts must be recomputed (a metric was added or removed). */
  recompute: boolean
  applied: string[]
  rejected: string[]
}

const without = <T,>(list: T[], item: T) => list.filter((value) => value !== item)
const withItem = <T,>(list: T[], item: T) => (list.includes(item) ? list : [...list, item])

/**
 * Apply a list of operations. Each one is validated against what the
 * dashboard actually has; an operation that names something that does not
 * exist is rejected with a reason and the rest still apply, so one typo
 * does not throw away a whole request.
 */
export function applyOperations(current: { view: RoiView; narrative: RoiNarrative }, operations: RoiOperation[], context: ApplyContext): ApplyResult {
  const view: RoiView = JSON.parse(JSON.stringify(current.view))
  const narrative: RoiNarrative = JSON.parse(JSON.stringify(current.narrative))
  const applied: string[] = []
  const rejected: string[] = []
  let recompute = false
  const metricExists = (key: string) => context.metricKeys.includes(key) || view.extraMetrics.some((metric) => metric.key === key)

  for (const operation of operations) {
    switch (operation.op) {
      case 'hide_tab':
        view.hiddenTabs = withItem(view.hiddenTabs, operation.tab)
        applied.push(`Hid the ${ROI_TAB_LABEL[operation.tab]} tab`)
        break
      case 'show_tab':
        view.hiddenTabs = without(view.hiddenTabs, operation.tab)
        applied.push(`Showed the ${ROI_TAB_LABEL[operation.tab]} tab`)
        break
      case 'hide_section':
      case 'show_section': {
        operation.section = LEGACY_SECTIONS[operation.section] ?? operation.section
        if (!(operation.section in ROI_SECTIONS)) {
          rejected.push(`No section "${operation.section}". Sections: ${Object.keys(ROI_SECTIONS).join(', ')}.`)
          break
        }
        view.hiddenSections = operation.op === 'hide_section' ? withItem(view.hiddenSections, operation.section) : without(view.hiddenSections, operation.section)
        applied.push(`${operation.op === 'hide_section' ? 'Hid' : 'Showed'} ${ROI_SECTIONS[operation.section as RoiSection]}`)
        break
      }
      case 'hide_metric':
      case 'show_metric':
        if (!metricExists(operation.metric)) {
          rejected.push(`No metric "${operation.metric}". Metrics: ${[...context.metricKeys, ...view.extraMetrics.map((m) => m.key)].join(', ')}.`)
          break
        }
        view.hiddenMetrics = operation.op === 'hide_metric' ? withItem(view.hiddenMetrics, operation.metric) : without(view.hiddenMetrics, operation.metric)
        applied.push(`${operation.op === 'hide_metric' ? 'Removed' : 'Restored'} the metric ${view.metricLabels[operation.metric] ?? operation.metric}`)
        break
      case 'rename_metric':
        if (!metricExists(operation.metric)) {
          rejected.push(`No metric "${operation.metric}" to rename.`)
          break
        }
        view.metricLabels[operation.metric] = operation.label
        applied.push(`Renamed ${operation.metric} to "${operation.label}"`)
        break
      case 'add_metric': {
        const metric = operation.metric
        const missing = metric.columns.filter((column) => !context.activityColumns.includes(column))
        if (missing.length) {
          rejected.push(`The activity extract has no column ${missing.join(', ')}. Numeric columns include: ${context.activityColumns.slice(0, 40).join(', ')}.`)
          break
        }
        if (context.metricKeys.includes(metric.key)) {
          rejected.push(`"${metric.key}" is already a metric; show it or rename it instead.`)
          break
        }
        view.extraMetrics = [...view.extraMetrics.filter((m) => m.key !== metric.key), metric]
        view.hiddenMetrics = without(view.hiddenMetrics, metric.key)
        recompute = true
        applied.push(`Added the metric "${metric.label}" (${metric.columns.join(' + ')})`)
        break
      }
      case 'remove_added_metric':
        if (!view.extraMetrics.some((m) => m.key === operation.metric)) {
          rejected.push(`"${operation.metric}" is not an added metric; hide it instead.`)
          break
        }
        view.extraMetrics = view.extraMetrics.filter((m) => m.key !== operation.metric)
        recompute = true
        applied.push(`Removed the added metric ${operation.metric}`)
        break
      case 'set_default_comparison':
        if (!isRoiTimeframePreset(operation.preset)) {
          rejected.push(`Unknown comparison "${operation.preset}". Use last6_vs_prior6, last6_vs_year_ago, last12_vs_prior12 or last3_vs_prior3.`)
          break
        }
        view.defaultComparison = operation.preset as RoiTimeframePreset
        applied.push(`Set the default comparison to ${operation.preset}`)
        break
      case 'set_headline':
        narrative.headline = operation.text
        applied.push('Rewrote the headline')
        break
      case 'set_lede':
        narrative.lede = operation.text
        applied.push('Rewrote the lede')
        break
      case 'remove_finding':
        if (operation.index >= narrative.findings.length) { rejected.push(`There is no finding ${operation.index + 1}.`); break }
        if (narrative.findings.length <= 1) { rejected.push('The summary needs at least one finding; hide the findings section instead.'); break }
        applied.push(`Removed the finding "${narrative.findings[operation.index].h}"`)
        narrative.findings.splice(operation.index, 1)
        break
      case 'upsert_finding':
        if (operation.index !== undefined && operation.index < narrative.findings.length) {
          narrative.findings[operation.index] = operation.finding
          applied.push(`Rewrote finding ${operation.index + 1}`)
        } else if (narrative.findings.length >= 6) {
          rejected.push('The summary holds at most six findings; replace one instead.')
        } else {
          narrative.findings.push(operation.finding)
          applied.push(`Added the finding "${operation.finding.h}"`)
        }
        break
      case 'remove_watch_item':
        if (operation.index >= narrative.watch.length) { rejected.push(`There is no watch item ${operation.index + 1}.`); break }
        applied.push(`Removed the watch item "${narrative.watch[operation.index].lead}"`)
        narrative.watch.splice(operation.index, 1)
        break
      case 'upsert_watch_item':
        if (operation.index !== undefined && operation.index < narrative.watch.length) {
          narrative.watch[operation.index] = operation.item
          applied.push(`Rewrote watch item ${operation.index + 1}`)
        } else {
          narrative.watch.push(operation.item)
          applied.push(`Added the watch item "${operation.item.lead}"`)
        }
        break
      case 'set_note':
        narrative.notes = { ...narrative.notes, [operation.note]: operation.paragraphs }
        applied.push(`Rewrote the ${operation.note} commentary`)
        break
      case 'add_caveat':
        narrative.caveats = [...(narrative.caveats ?? []), operation.text]
        applied.push('Added a caveat')
        break
      case 'set_style': {
        const cssProblem = operation.style.css ? unsafeCustomCss(operation.style.css) : null
        if (cssProblem) { rejected.push(cssProblem); break }
        view.style = { ...(view.style ?? {}), ...operation.style }
        const what = [operation.style.accent ? `accent ${operation.style.accent}` : '', operation.style.series ? `${operation.style.series.length} series colours` : '', operation.style.density ? `${operation.style.density} density` : '', operation.style.css ? 'custom CSS' : ''].filter(Boolean)
        applied.push(`Styled the report${what.length ? `: ${what.join(', ')}` : ''}`)
        break
      }
      case 'reset_style':
        delete view.style
        applied.push('Reset the report to the brand style')
        break
      case 'set_chart':
      case 'reset_chart': {
        if (!(operation.chart in ROI_CHARTS)) {
          rejected.push(`No chart "${operation.chart}". Charts: ${Object.keys(ROI_CHARTS).join(', ')}.`)
          break
        }
        if (operation.op === 'reset_chart') {
          delete view.charts[operation.chart]
          applied.push(`Reset the ${operation.chart} chart to its default drawing`)
          break
        }
        view.charts[operation.chart] = { ...(view.charts[operation.chart] ?? {}), ...operation.options }
        applied.push(`Changed the ${operation.chart} chart: ${Object.keys(operation.options).join(', ')}`)
        break
      }
      case 'add_section': {
        const section = operation.customSection
        const problem = unsafeCustomHtml(section.html)
        if (problem) { rejected.push(problem); break }
        const existing = view.sections.findIndex((item) => item.id === section.id)
        if (existing < 0 && view.sections.length >= ROI_CUSTOM_SECTIONS_MAX) { rejected.push(`The report holds at most ${ROI_CUSTOM_SECTIONS_MAX} added sections; remove one first.`); break }
        if (existing >= 0) view.sections[existing] = section
        else view.sections.push(section)
        applied.push(`${existing >= 0 ? 'Rewrote' : 'Added'} the section "${section.title}" on the ${section.tab === 'summary' ? 'Executive summary' : ROI_TAB_LABEL[section.tab]} tab`)
        break
      }
      case 'remove_section': {
        const index = view.sections.findIndex((item) => item.id === operation.id)
        if (index < 0) { rejected.push(`No added section "${operation.id}". Added sections: ${view.sections.map((item) => item.id).join(', ') || 'none'}.`); break }
        applied.push(`Removed the section "${view.sections[index].title}"`)
        view.sections.splice(index, 1)
        break
      }
      case 'set_section_title': {
        const section = LEGACY_SECTIONS[operation.section] ?? operation.section
        if (!(section in ROI_SECTIONS)) { rejected.push(`No section "${operation.section}" to retitle. Sections: ${Object.keys(ROI_SECTIONS).join(', ')}.`); break }
        view.sectionTitles[section] = operation.title
        applied.push(`Retitled ${ROI_SECTIONS[section as RoiSection]} to "${operation.title}"`)
        break
      }
    }
  }
  if (view.hiddenTabs.length >= ROI_TABS.length) {
    rejected.push('At least one tab besides the Executive summary stays visible.')
    view.hiddenTabs = view.hiddenTabs.slice(0, ROI_TABS.length - 1)
  }
  return { view, narrative, recompute, applied, rejected }
}

/** What the assistant is told the dashboard can do — the edit vocabulary. */
export function describeView(view: RoiView, metricLabels: Record<string, string>): Record<string, unknown> {
  return {
    tabs: ROI_TABS.map((tab) => ({ tab, label: ROI_TAB_LABEL[tab], hidden: view.hiddenTabs.includes(tab) })),
    sections: Object.entries(ROI_SECTIONS).map(([section, what]) => ({ section, what, hidden: view.hiddenSections.includes(section) })),
    metrics: Object.entries(metricLabels).map(([key, label]) => ({ key, label: view.metricLabels[key] ?? label, hidden: view.hiddenMetrics.includes(key), added: view.extraMetrics.some((m) => m.key === key) })),
    addedMetrics: view.extraMetrics,
    defaultComparison: view.defaultComparison ?? null,
    charts: Object.entries(ROI_CHARTS).map(([chart, what]) => ({ chart, what, ...(view.charts[chart] ? { options: view.charts[chart] } : {}) })),
    style: view.style ?? null,
    addedSections: view.sections.map(({ html, ...section }) => ({ ...section, htmlChars: html.length })),
    sectionTitles: view.sectionTitles,
  }
}
