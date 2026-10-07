import { z } from 'zod'

/**
 * The ROI agent's output contract — the narrative.
 *
 * The numbers come from the prep (prepare_roi_facts, prepare_account360) and
 * the report's own script; the model writes what they mean. Every slot below
 * maps to a place on the report: the masthead, the findings, the watch list,
 * the Backstory account context, and the "What this shows" aside beside each
 * chart. Sections whose data is missing are omitted from the report, so their
 * asides are optional.
 */

const para = z.string().min(1).max(2_000)
const paras = z.array(para).min(1).max(4)

/** The report's tabs a finding can point at. */
export const ROI_FINDING_TABS = ['activity', 'adoption', 'deals', 'accounts'] as const
export type RoiFindingTab = (typeof ROI_FINDING_TABS)[number]

/** Tab ids from the seven-tab dashboard, mapped onto the consolidated report. */
export const LEGACY_TAB: Record<string, RoiFindingTab> = { lead: 'activity', adopt: 'adoption', users: 'adoption', deal: 'deals', stage: 'deals' }

export const findingTabSchema = z.preprocess(
  (value) => (typeof value === 'string' && value in LEGACY_TAB ? LEGACY_TAB[value] : value),
  z.enum(ROI_FINDING_TABS),
)

export const findingSchema = z.object({
  /** The figure, formatted: "2.0×", "+54%", "30%", "+9 pts". */
  fig: z.string().min(1).max(16),
  /** What the figure is: "win rate, high vs low engagement". */
  cap: z.string().min(1).max(80),
  /** The finding as a short heading. */
  h: z.string().min(1).max(90),
  /** One or two sentences with the numbers that prove it. */
  p: z.string().min(1).max(1_200),
  /** Which tab shows the detail. */
  tab: findingTabSchema,
})

export const ROI_NOTE_KEYS = ['lead', 'mix', 'adopt', 'users', 'usersTrend', 'dealWin', 'dealVel', 'dealTrend', 'stageProf', 'stageHeat', 'stageSurv', 'breadth', 'accounts', 'accountDeals'] as const

export const roiNarrativeSchema = z.object({
  /** One sentence, the thesis. Rendered as the masthead headline. */
  headline: z.string().min(10).max(240),
  /** Two or three sentences under the headline. */
  lede: z.string().min(10).max(1_200),
  findings: z.array(findingSchema).min(2).max(6),
  /** Three or four "what to watch" items; a bold lead phrase then the point. */
  watch: z.array(z.object({ lead: z.string().min(1).max(160), text: z.string().min(1).max(1_200) })).min(2).max(6),
  /**
   * Account context from the Backstory platform (where the relationship
   * stands, what is coming up), when the analyst could look the account up.
   * Framing only — never a computed number.
   */
  context: z.object({
    summary: z.string().min(1).max(600),
    facts: z.array(z.object({ label: z.string().min(1).max(60), value: z.string().min(1).max(160), source: z.string().max(60).default('Backstory') })).max(4).default([]),
  }).optional(),
  notes: z.object({
    lead: paras.optional(),
    mix: paras.optional(),
    adopt: paras.optional(),
    users: paras.optional(),
    usersTrend: paras.optional(),
    dealWin: paras.optional(),
    dealVel: paras.optional(),
    dealTrend: paras.optional(),
    stageProf: paras.optional(),
    stageHeat: paras.optional(),
    stageSurv: paras.optional(),
    persona: z.object({ wr: para, share: para, days: para }).optional(),
    breadth: paras.optional(),
    accounts: paras.optional(),
    accountDeals: paras.optional(),
  }),
  /** Data notes for the Method tab — joins that did not match, exclusions, anything a sceptical reader should know. */
  caveats: z.array(z.string().max(800)).max(12).default([]),
})

export type RoiNarrative = z.infer<typeof roiNarrativeSchema>

/** A narrative that runs long is trimmed, not rejected: the page has room
 *  limits, the analysis does not deserve to fail over them. Strings are cut
 *  at a generous ceiling and lists at their maximum length. */
function clampStrings(value: unknown, depth = 0): unknown {
  if (depth > 6) return value
  if (typeof value === 'string') return value.length > 2_000 ? value.slice(0, 1_997).trimEnd() + '…' : value
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => clampStrings(item, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const limit = key === 'headline' ? 240 : key === 'lede' ? 1_200 : key === 'fig' ? 16 : key === 'cap' ? 80 : key === 'h' ? 90 : key === 'lead' ? 160 : key === 'p' || key === 'text' ? 1_200 : key === 'summary' ? 600 : key === 'label' ? 60 : key === 'value' ? 160 : null
      const clamped = clampStrings(item, depth + 1)
      out[key] = limit !== null && typeof clamped === 'string' && clamped.length > limit ? clamped.slice(0, limit - 1).trimEnd() + '…' : clamped
    }
    return out
  }
  return value
}

export function extractRoiNarrative(text: string): { data: RoiNarrative; error?: undefined } | { data?: undefined; error: string } {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidates = [fenced?.[1], text].filter((value): value is string => typeof value === 'string')
  let lastError = 'No JSON object was found in the agent output.'
  for (const candidate of candidates) {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start < 0 || end <= start) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate.slice(start, end + 1))
    } catch (error) {
      lastError = `The agent output was not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      continue
    }
    const result = roiNarrativeSchema.safeParse(clampStrings(parsed))
    if (result.success) return { data: result.data }
    const issue = result.error.issues[0]
    lastError = `The agent output did not match the ROI narrative contract at ${issue.path.join('.') || 'root'}: ${issue.message}`
  }
  return { error: lastError }
}

/** The contract as the agent sees it (it travels in every run's prompt). */
export const ROI_OUTPUT_CONTRACT = `Return ONE JSON object (in a \`\`\`json fence, nothing after it):
{
  "headline": "<one sentence: the thesis, e.g. 'Engaged deals win twice as often, and Backstory users create that engagement.'>",
  "lede": "<2-3 sentences under the headline: the chain from usage to behaviour to engagement to outcome, with the key numbers>",
  "context": { "summary": "<1-2 sentences: where the relationship stands, from the Backstory platform>", "facts": [ { "label": "<e.g. Renewal>", "value": "<e.g. Mar 2027, $1.2M>", "source": "Backstory" } ] },  // OPTIONAL — only when you looked the account up on the Backstory platform; omit otherwise
  "findings": [ { "fig": "<formatted figure, e.g. 2.0× or +54% or +9 pts>", "cap": "<what the figure is>", "h": "<finding as a heading>", "p": "<1-2 sentences with the proving numbers>", "tab": "activity|adoption|deals|accounts" } ],  // 3-6 items, strongest first, one per area that has data
  "watch": [ { "lead": "<bold lead phrase>", "text": "<the point, with numbers>" } ],  // 3-4 items: risks, levers, and one honest caveat about correlation
  "notes": {   // the "What this shows" aside beside each chart; 1-3 short paragraphs each; omit a key when its section has no data
    "lead": ["..."],        // activity trends: what moved, observation vs baseline, org-wide
    "mix": ["..."],         // senior engagement (Director/VP/Exec) across the three periods
    "adopt": ["..."],       // high/medium/low adopters
    "users": ["..."],       // users vs non-users lift
    "usersTrend": ["..."],  // the cohort gap over time, read fairly (correlation)
    "dealWin": ["..."],     // win rate by engagement decile/level
    "dealVel": ["..."],     // velocity: won and lost
    "dealTrend": ["..."],   // engagement vs outcomes over time / by fiscal year
    "stageProf": ["..."],   // where activity lands by stage; won vs lost per deal
    "stageHeat": ["..."],   // the stage × persona heatmap: who is engaged where on won vs lost deals
    "stageSurv": ["..."],   // early vs late engagement among late-stage deals
    "persona": { "wr": "...", "share": "...", "days": "..." },  // one paragraph per persona view
    "breadth": ["..."],     // buying-committee breadth and early activity intensity
    "accounts": ["..."],    // Account 360 cohorts vs pipeline per account
    "accountDeals": ["..."] // deal engagement per account: win rate vs engagement
  },
  "caveats": ["<data notes for the Method tab>"]
}`
