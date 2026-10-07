import test from 'node:test'
import assert from 'node:assert/strict'
import { extractRoiNarrative, type RoiNarrative } from '../contract'
import { renderRoiDashboard } from '../dashboard'
import { summarizeFacts, winAvg, popMask, windows } from '../facts'
import type { RoiFacts } from '../prep'
import { buildAnalysisPrompt, buildStandardPrompt } from '../service'

const narrative: RoiNarrative = {
  headline: 'Engaged deals win twice as often, and Backstory users create that engagement.',
  lede: 'Win rate climbs to **48%** with engagement. Users hold more senior meetings.',
  findings: [
    { fig: '2.0×', cap: 'win rate, high vs low engagement', h: 'Engaged deals win about twice as often', p: 'High-engagement deals win **48%** vs **22%**.', tab: 'deals' },
    { fig: '+54%', cap: 'senior meetings, users vs non-users', h: 'Users reach senior buyers more often', p: '6.3 vs 4.1 per rep per month.', tab: 'adoption' },
  ],
  watch: [{ lead: 'Senior access is slipping.', text: 'Director+ meetings per rep are **-7.7%** vs the prior six months.' }, { lead: 'These are correlations.', text: 'Users self-select.' }],
  notes: {
    lead: ['Meetings held flat; senior meetings fell.'],
    dealWin: ['Top decile wins 48.6% against 7.9% for the bottom.'],
    stageProf: ['Most activity lands in Qualification.'],
    persona: { wr: 'Ops buyers lift win rate.', share: 'Directors appear on a third of won deals.', days: 'Engaged deals are larger.' },
  },
  caveats: ['No usage cohort file was provided.'],
}

const facts: RoiFacts = {
  U: {
    months: ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12'],
    users: [{ t: null, f: null, g: 'East' }, { t: null, f: null, g: 'West' }],
    m: { meeting_count: [[1, 1, 1, 1, 1, 1, 3, 3, 3, 3, 3, 3], [null, 2, 2, 2, 2, 2, 4, 4, 4, 4, 4, 4]] },
    labels: { meeting_count: 'Meetings' },
    tierCuts: [],
    nUsage: 0,
    nBottom: 0,
    hasUsage: false,
    usageRecords: 0,
  },
  OPP: {
    'All (excl. renewals)': {
      excl: { deciles: [{ dec: 1, n: 10, won: 1, win_rate: 10, med_days_won: null, avg_days_won: null, med_days_lost: null, lo: 0, hi: 9 }], levels: [{ level: 'Low (0–30)', n: 10, won: 1, win_rate: 10, med_days_won: null, avg_days_won: null, med_days_lost: null, lo: 0, hi: 30 }], n: 10, win_rate: 10, r_win: null },
      incl: { deciles: [], levels: [], n: 10, win_rate: 10, r_win: null },
    },
  },
  ST: null,
  META: { medWon: 3100, meanWonCap: 56000, capP: 1, capPO: 1, hasVelocity: false },
  notes: ['No closed-deals-by-stage file — the stage and persona analysis is unavailable.'],
}

test('extracts and validates the narrative from a fenced answer', () => {
  const text = `Here it is.\n\`\`\`json\n${JSON.stringify(narrative)}\n\`\`\``
  const result = extractRoiNarrative(text)
  assert.equal(result.error, undefined)
  assert.equal(result.data?.findings.length, 2)
})

test('explains a contract violation in words', () => {
  const result = extractRoiNarrative(JSON.stringify({ ...narrative, findings: [] }))
  assert.match(result.error ?? '', /findings/)
  assert.match(extractRoiNarrative('no json here').error ?? '', /No JSON object/)
})

test('window averages: per-rep mean across months, then across reps', () => {
  const U = facts.U!
  const W = windows(U.months.length)
  const last6 = winAvg(U, popMask(U, 'all'), W.L6)
  const prior6 = winAvg(U, popMask(U, 'all'), W.P6)
  assert.equal(last6.meeting_count, 3.5)
  assert.equal(prior6.meeting_count, 1.5)
  assert.equal(last6.n, 2)
  const summary = summarizeFacts(facts)
  assert.equal((summary.activity as { reps: number }).reps, 2)
  assert.equal(summary.stages, null)
})

test('renders the consolidated report with narrative slots, hiding sections without data', () => {
  const html = renderRoiDashboard(facts, narrative, { account: 'Iron Mountain', generatedAt: '2026-09-29T12:00:00.000Z', timeframePreset: 'last6_vs_year_ago', reason: 'Renewal' })
  assert.match(html, /<title>Backstory ROI analysis · Iron Mountain<\/title>/)
  assert.match(html, /<h1>Engaged deals win twice as often/)
  assert.match(html, /src="\/vendor\/plotly\.min\.js"/)
  for (const tab of ['summary', 'activity', 'adoption', 'deals', 'accounts', 'method']) assert.match(html, new RegExp(`data-tab="${tab}"`))
  assert.match(html, /Prepared for: Renewal/)
  assert.match(html, /No usage cohort file was provided/)
  assert.match(html, /const CFG = \{[^\n]*"comparison":"year_ago"/)
  assert.match(html, /<p class="lede">Win rate climbs to <b class="num">48%<\/b>/) // **bold** in narrative becomes a number span
})

test('a narrative written for the seven-tab dashboard still points its findings at the right tabs', () => {
  const legacy = { ...narrative, findings: [{ ...narrative.findings[0], tab: 'stage' }, { ...narrative.findings[1], tab: 'users' }] } as unknown as RoiNarrative
  const html = renderRoiDashboard(facts, legacy, { account: 'Acme' })
  assert.match(html, /"tab":"deals"/)
  assert.match(html, /"tab":"adoption"/)
  assert.equal(extractRoiNarrative(JSON.stringify({ ...narrative, findings: [{ ...narrative.findings[0], tab: 'lead' }, narrative.findings[1]] })).data?.findings[0].tab, 'activity')
})

test('Backstory account context renders as framing, escaped', () => {
  const html = renderRoiDashboard(facts, { ...narrative, context: { summary: 'Renewal due <soon>.', facts: [{ label: 'Renewal', value: 'Mar 2027', source: 'Backstory' }] } }, { account: 'Acme' })
  assert.match(html, /Account context · Backstory/)
  assert.match(html, /Renewal due &lt;soon&gt;\./)
  assert.match(html, /<dt>Renewal<\/dt><dd>Mar 2027<small>Backstory<\/small><\/dd>/)
})

test('embedded JSON and narrative cannot break out of the page', () => {
  const hostile: RoiNarrative = { ...narrative, headline: 'Acme</script><script>alert(1)</script> wins' }
  const html = renderRoiDashboard(facts, hostile, { account: 'Acme</title><script>x</script>' })
  assert.doesNotMatch(html, /const N = [^\n]*<\/script><script>alert/)
  assert.match(html, /<h1>Acme&lt;\/script&gt;/)
  assert.match(html, /<title>Backstory ROI analysis · Acme&lt;\/title&gt;/)
})

test('the analysis prompt names the datasets by frame and document id', () => {
  const datasets = [{ documentId: 'doc1', filename: 'Raw Data Extract.csv', frame: 'raw_data_extract', rows: 38259 }]
  const prompt = buildAnalysisPrompt({ account: 'Iron Mountain', timeframe: { preset: 'last6_vs_year_ago' }, context: 'Focus on EMEA.', datasets })
  assert.match(prompt, /documentId doc1, frame "raw_data_extract", 38,259 rows/)
  assert.match(prompt, /same 6 calendar months one year earlier/)
  assert.match(prompt, /Focus on EMEA/)
  assert.match(prompt, /OUTPUT\nReturn ONE JSON object/) // the contract travels in the prompt, not only the agent's instructions
})

test('the standard prompt routes each extract to its prep and carries the configuration, the reason and the contract', () => {
  const datasets = [
    { documentId: 'act', filename: 'Raw.csv', frame: 'raw', rows: 10, kind: 'activity' as const },
    { documentId: 'clk', filename: 'Clicks.csv', frame: 'clicks', rows: 5, kind: 'clickstream' as const },
  ]
  const prompt = buildStandardPrompt({ account: 'Anaplan', config: { windowMonths: 12, comparison: 'year_ago', cohort: 'users', fiscalYearStartMonth: 2, custom: null }, reason: 'QBR', context: '', datasets })
  assert.match(prompt, /WHY IT WAS RUN: QBR/)
  assert.match(prompt, /Last 12 months vs the same 12 last year\. Cohorts: users vs non-users\. Fiscal year starts in February/)
  assert.match(prompt, /prepare_roi_facts ONCE with documentIds \["act"\]/)
  assert.match(prompt, /prepare_account360 ONCE with documentIds \["clk"\]/)
  assert.match(prompt, /"tab": "activity\|adoption\|deals\|accounts"/)
})

test('an over-long narrative is trimmed rather than rejected', () => {
  const long = { ...narrative, lede: 'x'.repeat(3_000), findings: [{ ...narrative.findings[0], p: 'y'.repeat(5_000) }, narrative.findings[1]] }
  const result = extractRoiNarrative(JSON.stringify(long))
  assert.equal(result.error, undefined)
  assert.ok(result.data!.lede.length <= 1_200)
  assert.ok(result.data!.lede.endsWith('…'))
  assert.ok(result.data!.findings[0].p.length <= 1_200)
})
