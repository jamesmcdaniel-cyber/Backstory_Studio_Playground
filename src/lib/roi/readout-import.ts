import type { DealTable, RoiFacts, RoiReadoutAgg, RoiUser } from './prep'
import { roiNarrativeSchema, type RoiNarrative } from './contract'
import { DEFAULT_RUN_CONFIG, resolveWindows } from './config'
import { popMask, winAvg } from './facts'

/**
 * A value readout, imported as an account's ROI report.
 *
 * Backstory's own readout (the "Value Readout · People.ai" page) embeds its
 * data as one `const DATA = {...}` object: monthly averages per rep for the
 * whole team, each adoption cohort and each role; the roster; deal outcomes by
 * month, fiscal year, decile and type; stage × persona tables; accounts. No
 * rep- or deal-level rows. This turns that object into ROI facts the report
 * draws like any account's:
 *
 *  - the activity matrices hold group rows (team, cohorts, roles), each
 *    weighted by the reps it stands for, so the same averaging gives the
 *    readout's own numbers;
 *  - deal tables per type come from the decile and level aggregates, and the
 *    month and fiscal-year views read the aggregates directly (AGG);
 *  - stage and persona views read the readout's tables (AGG).
 *
 * Views that need reps or deals the readout does not carry (the
 * transactional-deal toggle, survivorship, persona involvement, committee
 * breadth, the upside model) are left out of the report.
 *
 * Emails in the roster are dropped: names and titles are enough to read it.
 */

type Row = Record<string, unknown>
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter((row): row is Row => Boolean(row) && typeof row === 'object') : [])
const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places
const pct = (fraction: number | null) => (fraction === null ? null : round(fraction * 100, 1))

export class ReadoutFormatError extends Error {}

/** The readout's data object, from the page's HTML. */
export function extractReadoutData(html: string): Row {
  const marker = /const\s+DATA\s*=\s*\{/.exec(html)
  if (!marker) throw new ReadoutFormatError('This file is not a value readout: it has no embedded data (const DATA = {…}).')
  // Walk the object literal to its closing brace (strings may hold braces),
  // writing it out as JSON on the way: the page is JavaScript, so it can hold
  // NaN and Infinity, which JSON cannot — they become null.
  const start = marker.index + marker[0].length - 1
  let depth = 0
  let inString = false
  let out = ''
  let closed = false
  for (let i = start; i < html.length; i += 1) {
    const c = html[i]
    if (inString) {
      out += c
      if (c === '\\') { out += html[i + 1] ?? ''; i += 1 }
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; out += c; continue }
    if (html.startsWith('NaN', i)) { out += 'null'; i += 2; continue }
    if (html.startsWith('-Infinity', i)) { out += 'null'; i += 8; continue }
    if (html.startsWith('Infinity', i)) { out += 'null'; i += 7; continue }
    out += c
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) { closed = true; break }
    }
  }
  if (!closed) throw new ReadoutFormatError('The readout\'s data does not end where it should; the file may be cut short.')
  let data: unknown
  try {
    data = JSON.parse(out)
  } catch {
    throw new ReadoutFormatError('The readout\'s data could not be read.')
  }
  const missing = ['monthly_activity', 'cohort_monthly', 'cohort_sizes', 'user_list', 'level_stats', 'decile_stats', 'opp_monthly_wr', 'opp_fy_wr', 'decile_fy', 'stage_wr', 'persona_by_stage', 'findings'].filter((key) => !(data as Row)[key])
  if (missing.length) throw new ReadoutFormatError(`The readout is missing ${missing.join(', ')}.`)
  return data as Row
}

/** The readout's role buckets, by title (its own rule), as the report names them. */
const ROLE_NAME: Record<string, string> = { AE: 'Account executives', 'CS/PS': 'CS / PS', SE: 'Solutions engineering', SDR: 'SDR / BDR', Leadership: 'Leadership', Other: 'Other' }
export function readoutRoleOf(title: string): string {
  const t = title.toLowerCase()
  if (/account executive|account manager/.test(t)) return ROLE_NAME.AE
  if (/customer success|technical success|consultant|engagement manager/.test(t)) return ROLE_NAME['CS/PS']
  if (/solution engineer|sales engineer|specialist/.test(t)) return ROLE_NAME.SE
  if (/development representative|bdr|sdr/.test(t)) return ROLE_NAME.SDR
  if (/vp|svp|director|president|chief|head of|manager/.test(t)) return ROLE_NAME.Leadership
  return ROLE_NAME.Other
}

const LEVEL_INDEX: Record<string, number> = { Low: 0, Medium: 1, High: 2 }
const LEVEL_LABEL = ['Low (0–30)', 'Medium (31–70)', 'High (71+)']
const quarter = (value: unknown) => str(value).replace(/^FQ/, 'Q')
const STAGE_ORDER = ['0 - Qualification', '1 - Discovery', '2 - Scoping', '3 - Validation', '4 - Proposal', '5 - Negotiation', '6 - Closing', '7 - Pending Closed Won']
const PERSONAS = ['Executive', 'VP', 'Director', 'Finance', 'IT', 'Engineering']
const PERSONA_FIELDS = ['exec', 'vp', 'director', 'finance', 'it', 'eng']
const HEAT_FIELDS = ['executive_activity_count', 'vp_activity_count', 'director_activity_count', 'finance_activity_count', 'it_activity_count', 'eng_activity_count']
const METRICS: Array<[string, string]> = [
  ['meeting_count', 'Meetings'],
  ['sent_email_count', 'Emails sent'],
  ['dir_vp_exec', 'Director + VP + Exec meetings'],
  ['director_meeting_count', 'Director meetings'],
  ['vp_meeting_count', 'VP meetings'],
  ['executive_meeting_count', 'Executive meetings'],
  ['pipeline_created', 'Pipeline created'],
]

function corr(xs: number[], ys: number[]): number | null {
  const n = xs.length
  if (n < 3) return null
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let a = 0, b = 0, c = 0
  for (let i = 0; i < n; i += 1) { a += (xs[i] - mx) * (ys[i] - my); b += (xs[i] - mx) ** 2; c += (ys[i] - my) ** 2 }
  return b && c ? Math.round((a / Math.sqrt(b * c)) * 100) / 100 : null
}

type Bucket = { n: number; won: number; vel: number | null; eng: number | null }
function sumBuckets(items: Bucket[]): Bucket {
  let n = 0, won = 0, velSum = 0, velN = 0, engSum = 0, engN = 0
  for (const item of items) {
    n += item.n
    won += item.won
    if (item.vel !== null) { velSum += item.vel * item.n; velN += item.n }
    if (item.eng !== null) { engSum += item.eng * item.n; engN += item.n }
  }
  return { n, won, vel: velN ? velSum / velN : null, eng: engN ? engSum / engN : null }
}

function dealTable(deciles: Array<Bucket & { dec: number }>, levels: Array<Bucket & { l: number }>): DealTable {
  const decileRows = deciles.filter((d) => d.n > 0).sort((a, b) => a.dec - b.dec).map((d) => ({
    dec: d.dec, n: d.n, won: d.won, win_rate: d.n ? round((d.won / d.n) * 100, 1) : null,
    med_days_won: null, avg_days_won: null, med_days_lost: null, avg_days: d.vel === null ? null : round(d.vel, 0),
    lo: d.eng === null ? 0 : round(d.eng, 0), hi: d.eng === null ? 0 : round(d.eng, 0),
  }))
  const levelRows = levels.filter((l) => l.n > 0).sort((a, b) => a.l - b.l).map((l) => ({
    level: LEVEL_LABEL[l.l], n: l.n, won: l.won, win_rate: l.n ? round((l.won / l.n) * 100, 1) : null,
    med_days_won: null, avg_days_won: null, med_days_lost: null, avg_days: l.vel === null ? null : round(l.vel, 0),
    lo: [0, 31, 71][l.l], hi: [30, 70, 100][l.l],
  }))
  const total = sumBuckets(levelRows.length ? levels : deciles)
  return {
    deciles: decileRows,
    levels: levelRows,
    n: total.n,
    win_rate: total.n ? round((total.won / total.n) * 100, 1) : 0,
    r_win: corr(decileRows.map((d) => d.dec), decileRows.map((d) => d.win_rate ?? 0)),
  }
}

export const READOUT_ALL_TYPES = 'All deal types'

/** The readout as ROI facts. */
export function readoutFacts(data: Row): RoiFacts {
  const monthly = rows(data.monthly_activity)
  const months = monthly.map((row) => str(row.month)).filter(Boolean)
  const at = new Map(months.map((month, i) => [month, i]))
  const series = (source: Row[], monthKey: string, metric: string): Array<number | null> => {
    const out: Array<number | null> = months.map(() => null)
    for (const row of source) {
      const i = at.get(str(row[monthKey]))
      if (i === undefined) continue
      const value = metric === 'dir_vp_exec'
        ? ['director_meeting_count', 'vp_meeting_count', 'executive_meeting_count'].reduce<number | null>((sum, key) => (num(row[key]) === null ? sum : (sum ?? 0) + (num(row[key]) as number)), null)
        : num(row[metric])
      out[i] = value === null ? null : round(value)
    }
    return out
  }

  // The roster, as the readout reports it (window totals); emails dropped.
  const roster = rows(data.user_list).map((user) => {
    const cohort = str(user.cohort)
    const tier = cohort === 'High' || cohort === 'Medium' || cohort === 'Low' ? cohort : null
    return {
      n: str(user.full_name) || str(user.email).split('@')[0],
      ti: str(user.title),
      r: readoutRoleOf(str(user.title)),
      t: tier,
      f: (tier ? 'User' : 'Non-user') as 'User' | 'Non-user',
      ev: num(user.total_events), a: num(user.account_visits), o: num(user.opp_visits), last: str(user.last_active) || null,
      meetings: num(user.meetings), emails: num(user.sent_emails), vp: num(user.vp_meetings), exec: num(user.exec_meetings), pipeline: num(user.pipeline),
    }
  })
  const findings = (data.findings ?? {}) as Row
  const reps = num(findings.total_active_users) ?? roster.length

  // Group rows: the whole team, each adoption cohort, each role.
  const sizes = (data.cohort_sizes ?? {}) as Row
  const cohortRows = rows(data.cohort_monthly)
  const roleRows = rows(data.role_monthly)
  const roleCount = (role: string) => roster.filter((user) => user.r === role).length
  const groups: Array<{ user: RoiUser; source: Row[]; key: string }> = [
    { user: { t: null, f: null, g: 'All reps', k: 'org' as const, w: reps }, source: monthly, key: 'month' },
    ...['High', 'Medium', 'Low'].map((tier) => ({ user: { t: tier, f: 'User', g: `${tier} adopters`, k: 'cohort' as const, w: num(sizes[tier]) ?? 0 }, source: cohortRows.filter((row) => row.cohort === tier), key: 'month_str' })),
    { user: { t: null, f: 'Non-user', g: 'Non-users', k: 'cohort' as const, w: num(sizes['Non-User']) ?? 0 }, source: cohortRows.filter((row) => row.cohort === 'Non-User'), key: 'month_str' },
    ...Object.keys(ROLE_NAME).map((role) => ({ user: { t: null, f: null, g: ROLE_NAME[role], r: ROLE_NAME[role], k: 'role' as const, w: roleCount(ROLE_NAME[role]) }, source: roleRows.filter((row) => row.role === role), key: 'month_str' })),
  ].filter((group) => group.source.length > 0)
  const m: Record<string, Array<Array<number | null>>> = {}
  for (const [metric] of METRICS) m[metric] = groups.map((group) => series(group.source, group.key, metric))
  const labels = Object.fromEntries(METRICS.map(([key, label]) => [key, label]))
  const mx: Record<string, Array<Array<number | null>>> = { received_email_count: groups.map((group) => series(group.source, group.key, 'received_email_count')) }
  const org = Object.fromEntries(['meeting_count', 'in_person_meeting_count', 'conference_call_count', 'sent_email_count', 'received_email_count'].map((key) => [key, series(monthly, 'month', key)]))

  // Deals: tables per type for the overall views; aggregates for months and years.
  const types = (Array.isArray(data.available_opp_types) ? data.available_opp_types : []).map(String)
  const monthlyDeals = rows(data.opp_monthly_wr).map((row) => ({ m: str(row.close_month), fy: str(row.fy), fq: quarter(row.fq), l: LEVEL_INDEX[str(row.eng_level)] ?? 0, t: str(row.opportunity_type), n: num(row.deals) ?? 0, won: num(row.won) ?? 0, vel: num(row.avg_vel) }))
  const fyDeals = rows(data.opp_fy_wr).map((row) => ({ fy: str(row.fy), l: LEVEL_INDEX[str(row.eng_level)] ?? 0, t: str(row.opportunity_type), n: num(row.deals) ?? 0, won: num(row.won) ?? 0, vel: num(row.avg_vel) }))
  const decileFy = rows(data.decile_fy).map((row) => ({ fy: str(row.fy), dec: Number(str(row.decile).replace(/\D/g, '')) || 0, t: str(row.opportunity_type), n: num(row.deals) ?? 0, won: num(row.won) ?? 0, vel: num(row.avg_vel), eng: num(row.avg_eng) }))
  const allDeciles = rows(data.decile_stats).map((row) => {
    const n = num(row.count) ?? 0
    return { dec: Number(str(row.decile).replace(/\D/g, '')) || 0, n, won: Math.round(n * (num(row.win_rate) ?? 0)), vel: num(row.avg_velocity), eng: num(row.avg_engagement) }
  })
  const allLevels = rows(data.level_stats).map((row) => {
    const n = num(row.count) ?? 0
    return { l: LEVEL_INDEX[str(row.level)] ?? 0, n, won: Math.round(n * (num(row.win_rate) ?? 0)), vel: num(row.avg_velocity), eng: num(row.avg_engagement) }
  })
  const OPP: NonNullable<RoiFacts['OPP']> = {}
  const allTable = dealTable(allDeciles, allLevels)
  OPP[READOUT_ALL_TYPES] = { excl: allTable, incl: allTable }
  for (const type of types) {
    const deciles = Array.from({ length: 10 }, (_, k) => ({ dec: k + 1, ...sumBuckets(decileFy.filter((row) => row.t === type && row.dec === k + 1)) }))
    const levels = [0, 1, 2].map((l) => ({ l, ...sumBuckets(fyDeals.filter((row) => row.t === type && row.l === l).map((row) => ({ ...row, eng: null }))) }))
    const table = dealTable(deciles, levels)
    if (table.n >= 20) OPP[type] = { excl: table, incl: table }
  }

  // Stages and personas.
  const personaRow = (row: Row) => PERSONA_FIELDS.map((field) => round(num(row[field]) ?? 0))
  const heatOf = (key: string, scale = 1) => {
    const source = (data[key] ?? {}) as Record<string, Row>
    return HEAT_FIELDS.map((field) => STAGE_ORDER.map((stage) => {
      const value = num(source[stage]?.[field])
      return value === null ? null : round(value * scale, scale === 1 ? 2 : 1)
    }))
  }
  const stages: RoiReadoutAgg['stages'] = {
    order: STAGE_ORDER.filter((stage) => rows(data.stage_wr).some((row) => row.activity_match_stage === stage)),
    personas: PERSONAS,
    wr: rows(data.stage_wr).map((row) => ({ stage: str(row.activity_match_stage), n: num(row.total) ?? 0, won: num(row.won) ?? 0 })),
    wrFy: rows(data.stage_wr_fy).map((row) => ({ fy: str(row.fy), stage: str(row.activity_match_stage), t: str(row.opportunity_type), n: num(row.total) ?? 0, won: num(row.won) ?? 0 })),
    persona: rows(data.persona_by_stage).map((row) => ({ stage: str(row.activity_match_stage), won: row.opportunity_is_won === true, n: num(row.opps) ?? 0, p: personaRow(row) })),
    personaFy: rows(data.persona_by_stage_fy).map((row) => ({ fy: str(row.fy), stage: str(row.activity_match_stage), won: row.opportunity_is_won === true, n: num(row.opps) ?? 0, p: personaRow(row) })),
    heat: { won: heatOf('heatmap_won'), lost: heatOf('heatmap_lost'), diff: heatOf('heatmap_diff'), wr: heatOf('heatmap_wr_pct', 100) },
  }

  const accounts = rows(data.acct_list_v2).map((row) => ({
    account: str(row.account_name), opps: num(row.total_opps) ?? 0, won: num(row.won) ?? 0, win_rate: pct(num(row.win_rate)) ?? 0,
    eng: num(row.avg_engagement), days: num(row.avg_velocity) === null ? null : Math.round(num(row.avg_velocity) as number), acts: num(row.total_activity) ?? 0,
    exec: num(row.exec_activity) ?? 0, vp: num(row.vp_activity) ?? 0, dir: num(row.dir_activity) ?? 0, depth: num(row.depth), breadth: num(row.breadth) ?? 0,
  }))
  const fys = [...new Set([...(Array.isArray(data.available_fys) ? data.available_fys.map(String) : []), ...fyDeals.map((row) => row.fy)])].filter(Boolean).sort()
  const windowTotals = (cohorts: unknown, users: unknown) => {
    const out: Record<string, Record<string, number | null>> = {}
    const add = (name: string, row: unknown) => {
      if (!row || typeof row !== 'object') return
      const r = row as Row
      const parts = ['director_meeting_count', 'vp_meeting_count', 'executive_meeting_count'].map((key) => num(r[key]))
      out[name] = { ...Object.fromEntries(METRICS.filter(([key]) => key !== 'dir_vp_exec').map(([key]) => [key, num(r[key])])), dir_vp_exec: parts.every((v) => v !== null) ? parts.reduce((a, b) => (a as number) + (b as number), 0) : null }
    }
    const c = (cohorts ?? {}) as Row
    const u = (users ?? {}) as Row
    for (const tier of ['High', 'Medium', 'Low']) add(tier, c[tier])
    add('Non-user', c['Non-User'] ?? u['Non-User'])
    add('User', u.User)
    return out
  }

  return {
    U: {
      months,
      users: groups.map((group) => group.user),
      m,
      mx,
      labels,
      tierCuts: [],
      nUsage: roster.length,
      nBottom: 0,
      hasUsage: true,
      usageRecords: roster.length,
    },
    OPP,
    DEALS: null,
    ACC: accounts.length ? { accounts, nAccounts: accounts.length, nShown: accounts.length } : null,
    ST: null,
    META: { hasVelocity: true },
    notes: [
      `Built from the value readout's aggregates: monthly averages per rep for the team, each adoption cohort and each role; ${roster.length} people on the roster; ${allTable.n.toLocaleString()} closed deals by month, fiscal year, decile and type; stage and persona tables; ${accounts.length} accounts.`,
      'The readout carries no rep- or deal-level rows, so the transactional-deal toggle, survivorship, persona involvement, committee breadth and the upside model are left out. Velocity is the average days to close across won and lost deals.',
    ],
    AGG: { source: 'readout', reps, roster, org, cohortWindows: { l6: windowTotals(data.cohort_l6, data.user_l6), l12: windowTotals(data.cohort_l12, data.user_l12) }, fys, types, deals: { monthly: monthlyDeals, fy: fyDeals, decileFy }, stages },
  }
}

const money = (value: number) => (value >= 1e6 ? `$${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `$${Math.round(value / 1e3)}K` : `$${Math.round(value)}`)
const signed = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
const pctText = (fraction: number) => `${(fraction * 100).toFixed(1)}%`

/** The readout's own headline (its hero line), as plain text. */
export function readoutHeadline(html: string): string | null {
  const match = /<div class="hero-hl">([\s\S]*?)<\/div>/.exec(html)
  if (!match) return null
  const text = match[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, ' ').trim()
  return text.length >= 10 && text.length <= 240 ? text : null
}

/**
 * The readout's findings as the report's narrative: the readout's own
 * headline, and findings with every number taken from its data. The analyst
 * can rewrite it later from the ROI page.
 */
export function readoutNarrative(data: Row, account: string, html = '', facts: RoiFacts = readoutFacts(data)): RoiNarrative {
  // Activity and cohort numbers as the report's own views compute them (the
  // same windows, the same averaging), so the findings and the tiles agree;
  // deal and stage numbers from the readout's tables, which the deal and
  // stage views draw.
  const U = facts.U!
  const win = resolveWindows(U.months, DEFAULT_RUN_CONFIG)
  const avg = (pop: string, idx: number[]) => winAvg(U, popMask(U, pop), idx)
  const obs = avg('all', win.observation)
  const base = avg('all', win.baseline)
  const high = avg('High', win.observation)
  const non = avg('Non-user', win.observation)
  const change = (key: string) => {
    const a = obs[key]
    const b = base[key]
    return typeof a === 'number' && typeof b === 'number' && b ? (a / b - 1) * 100 : null
  }
  // Cohort comparisons from the readout's own six-month totals (quiet months count), as its views show them.
  const l6 = (facts.AGG?.cohortWindows?.l6 ?? {}) as Record<string, Record<string, number | null>>
  const ratio = (key: string) => {
    const a = l6.High?.[key] ?? high[key]
    const b = l6['Non-user']?.[key] ?? non[key]
    return typeof a === 'number' && typeof b === 'number' && b ? a / b : null
  }
  const levels = Object.fromEntries(rows(data.level_stats).map((row) => [str(row.level), row]))
  const highWr = num(levels.High?.win_rate) ?? 0
  const lowWr = num(levels.Low?.win_rate) ?? 0
  const highVel = Math.round(num(levels.High?.avg_velocity) ?? 0)
  const lowVel = Math.round(num(levels.Low?.avg_velocity) ?? 0)
  const deals = rows(data.level_stats).reduce((sum, row) => sum + (num(row.count) ?? 0), 0)
  const stageWr = Object.fromEntries(rows(data.stage_wr).map((row) => [str(row.activity_match_stage), num(row.win_rate) ?? 0]))
  const negotiation = stageWr['5 - Negotiation']
  const discovery = stageWr['1 - Discovery']
  const lift = lowWr ? highWr / lowWr : null
  const users = facts.AGG ? facts.AGG.roster.filter((user) => user.f === 'User').length : 0
  const yoy = ((data.findings_yoy ?? {}) as Row).eng_yoy as Record<string, Record<string, { win_rate?: number; deals?: number; avg_vel?: number }>> | undefined
  const fys = Object.keys(yoy?.Low ?? {}).sort()
  const [fa, fb] = fys.length >= 2 ? [fys[0], fys[1]] : [null, null]
  const meetings = obs.meeting_count
  const vpChange = change('vp_meeting_count')
  const execChange = change('executive_meeting_count')
  const meetingChange = change('meeting_count')
  const pipeChange = change('pipeline_created')
  const meetingRatio = ratio('meeting_count')
  const vpRatio = ratio('vp_meeting_count')
  const perMonth = (cohort: string, fallback: unknown) => (typeof l6[cohort]?.pipeline_created === 'number' ? (l6[cohort].pipeline_created as number) / 6 : typeof fallback === 'number' ? fallback : 0)
  const highPipe = perMonth('High', high.pipeline_created)
  const nonPipe = perMonth('Non-user', non.pipeline_created)
  const ownHeadline = readoutHeadline(html)
  const findings: RoiNarrative['findings'] = [
    { fig: pctText(highWr), cap: 'win rate, high-engagement deals', h: 'Engagement predicts the win', p: `High-engagement deals win **${pctText(highWr)}**${lift ? `, **${lift.toFixed(1)}×** the **${pctText(lowWr)}** of low-engagement deals` : ''}, across ${deals.toLocaleString()} closed deals.`, tab: 'deals' },
    { fig: money(highPipe), cap: 'pipeline per high adopter, per month', h: 'High adopters create the pipeline', p: `High adopters create **${money(highPipe)}** of pipeline per rep per month over the last six months; non-users create **${money(nonPipe)}**.`, tab: 'adoption' },
  ]
  if (typeof meetings === 'number' && vpChange !== null && execChange !== null && meetingChange !== null) findings.push({ fig: meetings.toFixed(1), cap: 'meetings per rep per month', h: vpChange > meetingChange ? 'Senior meetings are holding up best' : 'Where the meetings went', p: `Against the prior six months, VP meetings per rep are **${signed(vpChange)}** and executive meetings **${signed(execChange)}**, while meetings overall are **${signed(meetingChange)}**.`, tab: 'activity' })
  findings.push({ fig: `${Math.abs(lowVel - highVel)} days`, cap: lowVel >= highVel ? 'faster to close, high vs low engagement' : 'slower to close, high vs low engagement', h: lowVel >= highVel ? 'Engaged deals close faster' : 'Engaged deals take longer', p: `High-engagement deals close in **${highVel}** days on average, against **${lowVel}** for low engagement.`, tab: 'deals' })
  if (negotiation && discovery) findings.push({ fig: pctText(negotiation), cap: 'win rate with activity at Negotiation', h: 'Engagement late in the deal converts', p: `Deals with activity at Negotiation win **${pctText(negotiation)}**, against **${pctText(discovery)}** for deals with activity at Discovery.`, tab: 'stage' })
  if (meetingRatio !== null && vpRatio !== null) findings.push({ fig: `${users}`, cap: 'Backstory users in scope', h: 'High adopters out-engage non-users', p: `High adopters hold **${meetingRatio.toFixed(1)}×** the meetings of non-users and **${vpRatio.toFixed(1)}×** the VP meetings, per rep per month.`, tab: 'adoption' })
  const watch: RoiNarrative['watch'] = []
  if (fa && fb && yoy?.Low?.[fa]?.win_rate !== undefined && yoy.Low[fb]?.win_rate !== undefined) {
    const a = yoy.Low[fa].win_rate as number
    const b = yoy.Low[fb].win_rate as number
    watch.push({ lead: b < a ? 'Low-engagement deals are winning less.' : 'Low-engagement deals are holding up.', text: `They won **${pctText(a)}** in ${fa} and **${pctText(b)}** in ${fb}${b < a ? ', so the gap with engaged deals is widening' : ''}.` })
  }
  if (fys.length >= 3) watch.push({ lead: `${fys[fys.length - 1]} is in flight.`, text: 'Its deals are still closing, so its win rates move as the year completes.' })
  watch.push({ lead: 'These are correlations.', text: 'Adoption cohorts are self-selected, and an engaged deal may draw more activity because it is going well.' })
  if (watch.length < 2) watch.push({ lead: 'Six-month window.', text: 'Cohort comparisons cover the last six months; the trends cover two years.' })
  const narrative: RoiNarrative = {
    // The readout's own hero line when it is short enough to be a title.
    headline: ownHeadline && ownHeadline.length <= 100 ? ownHeadline : `Engaged deals win ${lift ? `${lift.toFixed(1)}×` : 'more'} as often, and ${account} users create the pipeline.`,
    lede: `High-engagement deals win **${pctText(highWr)}** against **${pctText(lowWr)}** for low engagement${lowVel > highVel ? ` and close **${lowVel - highVel} days** faster` : ''}.${meetingRatio !== null ? ` High adopters hold **${meetingRatio.toFixed(1)}×** the meetings of non-users and create **${money(highPipe)}** of pipeline per rep per month.` : ''}`,
    findings: findings.slice(0, 6),
    watch: watch.slice(0, 6),
    notes: {
      ...(typeof meetings === 'number' && pipeChange !== null && meetingChange !== null ? { lead: [`Over the last six months reps averaged **${meetings.toFixed(1)}** meetings a month; pipeline created per rep is **${signed(pipeChange)}** against the prior six months and meetings **${signed(meetingChange)}**.`] } : {}),
      adopt: [`High adopters outperform non-users on every leading indicator. The gap is widest in VP meetings${vpRatio ? ` (**${vpRatio.toFixed(1)}×**)` : ''} and in pipeline created.`],
      dealWin: [`Engagement is the strongest predictor of the outcome: high-engagement deals win **${pctText(highWr)}**${lift ? `, **${lift.toFixed(1)}×** low engagement` : ''}.`],
      stageHeat: ['Win rates rise as deals mature, but the pattern set in Discovery and Scoping predicts it: senior engagement early is what won deals have in common.'],
    },
    caveats: [],
  }
  return roiNarrativeSchema.parse(narrative)
}
