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

export const ROI_TABS = ['activity', 'adoption', 'deals', 'accounts', 'method'] as const
export type RoiTab = (typeof ROI_TABS)[number]

export const ROI_TAB_LABEL: Record<RoiTab, string> = {
  activity: 'Activity trends',
  adoption: 'Adoption impact',
  deals: 'Deal intelligence',
  accounts: 'Account engagement',
  method: 'Method',
}

/** The seven-tab dashboard's tabs: a new tab is hidden only when every old tab it absorbed was. */
const LEGACY_TABS: Record<RoiTab, string[]> = { activity: ['lead'], adoption: ['adopt', 'users'], deals: ['deal', 'stage'], accounts: [], method: ['method'] }

/** Every block the report can show or hide, with what it is. */
export const ROI_SECTIONS = {
  hero: 'Key findings: headline chart in the masthead',
  heroStats: 'Key findings: the four headline numbers',
  context: 'Key findings: account context from the Backstory platform',
  findings: 'Key findings: the findings',
  watch: 'Key findings: the "What to watch" list',
  calculator: 'Key findings: the "Model the upside" calculator',
  activityTiles: 'Activity trends: metric tiles, observation vs baseline',
  leadTrend: 'Activity trends: monthly trend chart',
  activityMix: 'Activity trends: meetings by channel and emails by direction',
  seniorMix: 'Activity trends: senior engagement across three periods',
  cohortKpis: 'Adoption impact: headline comparisons',
  adoptIndex: 'Adoption impact: activity by cohort',
  cohortSenior: 'Adoption impact: senior engagement by cohort',
  cohortPipeline: 'Adoption impact: pipeline by cohort',
  cohortDonut: 'Adoption impact: cohort composition',
  usersTrend: 'Adoption impact: the cohort gap over time',
  cohortTable: 'Adoption impact: per-rep averages by cohort',
  roster: 'Adoption impact: user roster',
  dealKpis: 'Deal intelligence: headline numbers',
  dealFindings: 'Deal intelligence: year-over-year findings',
  dealWin: 'Deal intelligence: win rate by engagement',
  dealVel: 'Deal intelligence: deal velocity',
  dealVolume: 'Deal intelligence: deal volume by engagement level',
  stageFindings: 'Deal intelligence: stage and persona findings',
  stageHeat: 'Deal intelligence: stage × persona heatmap',
  stageWin: 'Deal intelligence: win rate by stage',
  stageProf: 'Deal intelligence: engagement by stage',
  stageSurv: 'Deal intelligence: early vs late engagement',
  stagePersona: 'Deal intelligence: persona involvement',
  stageBreadth: 'Deal intelligence: committee breadth and early activity',
  a360Kpis: 'Account engagement: Account 360 cohort numbers',
  a360Cohorts: 'Account engagement: pipeline by Account 360 cohort',
  a360Scatter: 'Account engagement: sessions vs pipeline per account',
  a360Trend: 'Account engagement: pipeline trend by cohort',
  a360Table: 'Account engagement: Account 360 account table',
  accountDeals: 'Account engagement: win rate vs engagement per account',
  accountTable: 'Account engagement: account deal table',
} as const
export type RoiSection = keyof typeof ROI_SECTIONS

/** Section ids of the seven-tab dashboard that became another block. */
const LEGACY_SECTIONS: Record<string, RoiSection> = { leadTable: 'activityTiles', adoptTable: 'cohortTable', usersLift: 'adoptIndex', usersTable: 'cohortTable' }

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
})
export type RoiView = z.infer<typeof roiViewSchema>

function normalizeTabs(tabs: string[]): RoiTab[] {
  const hidden = new Set(tabs)
  return ROI_TABS.filter((tab) => hidden.has(tab) || (LEGACY_TABS[tab].length > 0 && LEGACY_TABS[tab].every((legacy) => hidden.has(legacy))))
}

/** A tab named the old way or the new. */
const tabSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value
  const match = (Object.entries(LEGACY_TABS) as Array<[RoiTab, string[]]>).find(([, legacy]) => legacy.includes(value))
  return (ROI_TABS as readonly string[]).includes(value) ? value : match?.[0] ?? value
}, z.enum(ROI_TABS))

export const EMPTY_VIEW: RoiView = { hiddenTabs: [], hiddenSections: [], hiddenMetrics: [], metricLabels: {}, extraMetrics: [] }

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
    }
  }
  if (view.hiddenTabs.length >= ROI_TABS.length) {
    rejected.push('At least one tab besides Summary stays visible.')
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
  }
}
