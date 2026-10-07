import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeDeals, decodeMatrix, dealGroup, defaultDealIndices, encodeMatrix, matrixOf, stagePersonaSignals, summarizeFacts, winAvg, popMask } from '../facts'
import { runKpis } from '../kpis'
import type { RoiDeals, RoiFacts } from '../prep'

const b36 = (n: number, width: number) => n.toString(36).padStart(width, '0')

/** 40 deals: scores 0..97.5, the top half won; every fourth a renewal; deal 0 transactional. */
function deals(): RoiDeals {
  const n = 40
  const scores = Array.from({ length: n }, (_, i) => i * 2.5)
  return {
    types: ['New Deal', 'Renewal'],
    months: ['2025-02', '2025-03'],
    n,
    s: scores.map((score) => b36(Math.round(score * 10), 2)).join(''),
    w: scores.map((_, i) => (i >= 20 ? '1' : '0')).join(''),
    d: scores.map((_, i) => (i === 0 ? 3 : 30 + i)),
    t: scores.map((_, i) => (i % 4 === 3 ? '1' : '0')).join(''),
    m: scores.map((_, i) => (i === 5 ? 'zz' : b36(i % 2, 2))).join(''),
    x: scores.map((_, i) => (i === 0 ? '1' : '0')).join(''),
  }
}

test('compact matrices round-trip, including empty months', () => {
  const matrix = [[1, null, 2.5], [null, null, 0]]
  assert.equal(encodeMatrix(matrix), '1,,2.5;,,0')
  assert.deepEqual(decodeMatrix(encodeMatrix(matrix)), matrix)
  assert.deepEqual(decodeMatrix(matrix), matrix)
})

test('compact deals decode to plain columns', () => {
  const decoded = decodeDeals(deals())
  assert.equal(decoded.s[3], 7.5)
  assert.equal(decoded.w[25], 1)
  assert.equal(decoded.t[3], 1)
  assert.equal(decoded.m[5], -1)
  assert.equal(decoded.x[0], 1)
})

test('deal buckets: renewals and transactional deals out by default; levels and equal-count deciles', () => {
  const decoded = decodeDeals(deals())
  const idx = defaultDealIndices(decoded)
  assert.equal(idx.length, 29) // 40 − 10 renewals − 1 transactional
  const group = dealGroup(decoded, idx)!
  assert.equal(group.n, 29)
  assert.deepEqual(group.levels.map((row) => row.level), ['Low (0–30)', 'Medium (31–70)', 'High (71+)'])
  assert.equal(group.levels[0].win_rate, 0) // scores ≤30 are all in the lost half
  assert.equal(group.levels[2].win_rate, 100)
  assert.equal(group.deciles.reduce((sum, row) => sum + row.n, 0), 29)
  assert.ok(group.r_win! > 0.8)
  assert.equal(dealGroup(decoded, idx.slice(0, 10)), null) // fewer than 20 deals: no table
})

test('the summary carries the configured windows and fiscal-year deal tables; KPIs compare like with like', () => {
  const facts: RoiFacts = {
    U: {
      months: ['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06'],
      users: [{ t: 'High', f: 'User', g: '' }, { t: 'Low', f: 'User', g: '' }],
      m: { meeting_count: '1,1,1,2,2,2;1,1,1,1,1,1', dir_vp_exec: '1,1,1,3,3,3;1,1,1,1,1,1', pipeline_created: '10,10,10,20,20,20;5,5,5,5,5,5' },
      labels: { meeting_count: 'Meetings', dir_vp_exec: 'Director + VP + Exec meetings', pipeline_created: 'Pipeline created' },
      tierCuts: [1, 2], nUsage: 2, nBottom: 0, hasUsage: true, usageRecords: 2,
    },
    OPP: null,
    DEALS: deals(),
    ST: null,
    META: {},
    notes: [],
  }
  assert.deepEqual(matrixOf(facts.U!, 'meeting_count')[0], [1, 1, 1, 2, 2, 2])
  assert.equal(winAvg(facts.U!, popMask(facts.U!, 'all'), [3, 4, 5]).meeting_count, 1.5)
  const config = { windowMonths: 3 as const, comparison: 'prior' as const, cohort: 'tiers' as const, fiscalYearStartMonth: 2, custom: null }
  const summary = summarizeFacts(facts, config) as unknown as { configured: { observation: string; byPopulation: Record<string, { changePct: Record<string, number> }> }; dealsByFiscalYear: { years: Record<string, unknown> } }
  assert.equal(summary.configured.observation, 'Apr – Jun 2025')
  assert.equal(summary.configured.byPopulation.all.changePct.meeting_count, 50)
  assert.deepEqual(Object.keys(summary.dealsByFiscalYear.years), ['FY2026'])
  const kpis = runKpis(facts, null, config)
  assert.deepEqual(kpis.map((kpi) => kpi.key), ['meeting_count', 'dir_vp_exec', 'pipeline_created', 'cohort_lift', 'win_high'])
  assert.equal(kpis.find((kpi) => kpi.key === 'meeting_count')!.display, '+50.0%')
})

test('stage × persona signals: averages per deal, win rate when present, post-decision stages not read as signals', () => {
  const ST = {
    // [stage, won, type, month, deals, acts, ...2 persona acts, ...2 persona present]
    cells: [[0, 1, 0, 0, 30, 60, 30, 0, 30, 0], [0, 0, 0, 0, 30, 30, 0, 15, 0, 20], [1, 1, 0, 0, 25, 50, 25, 25, 25, 25]],
    cellTypes: ['New Deal'], cellMonths: ['2025-03'], personaKeys: ['VP', 'IT'],
    stages: [{ stage: '1 Discovery', share: 50, dir_above_pct: 10, won_acts: 2, lost_acts: 1, won_n: 30, lost_n: 30 }, { stage: 'Closed', share: 50, dir_above_pct: 10, won_acts: 2, lost_acts: null, won_n: 25, lost_n: 0 }],
    personas: [], surv: [], breadth: [], early_q: [], base: { n_opps: 60, n_pre: 60, wr_pre: 50 }, n_late: 0, earlyStages: [], lateStages: [], postStages: ['Closed'], cycleMatch: null,
  } as unknown as NonNullable<RoiFacts['ST']>
  const signals = stagePersonaSignals(ST)
  assert.equal(signals.byStage[0].winRatePct, 50)
  assert.equal(signals.byStage[0].avgActsWon.VP, 1)
  assert.equal(signals.byStage[0].avgActsLost.IT, 0.5)
  assert.deepEqual(signals.strongestPreDecisionSignals.map((row) => [row.persona, row.winRatePct]), [['VP', 100], ['IT', 0]])
})
