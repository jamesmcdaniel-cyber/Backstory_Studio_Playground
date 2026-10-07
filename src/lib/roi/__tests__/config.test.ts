import test from 'node:test'
import assert from 'node:assert/strict'
import { configFromPreset, describeRunConfig, fiscalPeriodOf, presetFor, readRunConfig, resolveWindows, roiRunConfigSchema, runConfigWarnings, DEFAULT_RUN_CONFIG } from '../config'
import { roiAnalysisIdOfTrigger, ROI_DATA_FLOW_SOURCE } from '../data-source'

const months = Array.from({ length: 24 }, (_, i) => `${2024 + Math.floor((i + 6) / 12)}-${String(((i + 6) % 12) + 1).padStart(2, '0')}`) // 2024-07 … 2026-06

test('windows count back from the newest month: prior period and the same months a year earlier', () => {
  const prior = resolveWindows(months, { ...DEFAULT_RUN_CONFIG, windowMonths: 6 })
  assert.equal(prior.observationLabel, 'Jan – Jun 2026')
  assert.equal(prior.baselineLabel, 'Jul – Dec 2025')
  assert.equal(prior.yearAgoLabel, 'Jan – Jun 2025')
  const yoy = resolveWindows(months, { ...DEFAULT_RUN_CONFIG, windowMonths: 6, comparison: 'year_ago' })
  assert.equal(yoy.baselineLabel, 'Jan – Jun 2025')
  const twelve = resolveWindows(months, { ...DEFAULT_RUN_CONFIG, windowMonths: 12 })
  assert.deepEqual([twelve.observation.length, twelve.baseline.length], [12, 12])
})

test('explicit months pick exactly those months; a window the data does not reach comes back empty, not shifted', () => {
  const custom = resolveWindows(months, { ...DEFAULT_RUN_CONFIG, custom: { baseline: { from: '2024-09', to: '2025-02' }, observation: { from: '2025-09', to: '2026-02' } } })
  assert.equal(custom.baselineLabel, 'Sep 2024 – Feb 2025')
  assert.equal(custom.observation.length, 6)
  const early = resolveWindows(months, { ...DEFAULT_RUN_CONFIG, custom: { baseline: { from: '2020-01', to: '2020-06' }, observation: { from: '2026-01', to: '2026-06' } } })
  assert.deepEqual(early.baseline, [])
})

test('custom periods are validated in plain English: at least three months, baseline before observation', () => {
  const short = roiRunConfigSchema.safeParse({ custom: { baseline: { from: '2025-01', to: '2025-02' }, observation: { from: '2025-06', to: '2025-12' } } })
  assert.equal(short.success, false)
  assert.match(short.error!.issues[0].message, /baseline period needs at least 3 months \(6 is ideal\)/)
  const overlap = roiRunConfigSchema.safeParse({ custom: { baseline: { from: '2025-01', to: '2025-06' }, observation: { from: '2025-04', to: '2025-09' } } })
  assert.match(overlap.error!.issues.map((issue) => issue.message).join(' '), /must end before the observation period starts/)
  assert.deepEqual(runConfigWarnings({ ...DEFAULT_RUN_CONFIG, windowMonths: 3 }), ['Windows shorter than 6 months make trends noisier; 6 is ideal.'])
})

test('fiscal years are named for the calendar year they end in', () => {
  assert.deepEqual(fiscalPeriodOf('2025-02', 2), { fy: 'FY2026', fq: 'Q1' })
  assert.deepEqual(fiscalPeriodOf('2026-01', 2), { fy: 'FY2026', fq: 'Q4' })
  assert.deepEqual(fiscalPeriodOf('2024-08', 2), { fy: 'FY2025', fq: 'Q3' })
  assert.deepEqual(fiscalPeriodOf('2025-11', null), { fy: 'FY2025', fq: 'Q4' })
})

test('older presets and configs map both ways, and every config describes itself in words', () => {
  assert.equal(presetFor(configFromPreset('last12_vs_prior12')), 'last12_vs_prior12')
  assert.equal(presetFor(configFromPreset('last6_vs_year_ago')), 'last6_vs_year_ago')
  assert.deepEqual(readRunConfig({ nonsense: true }), DEFAULT_RUN_CONFIG)
  assert.deepEqual(describeRunConfig({ ...DEFAULT_RUN_CONFIG, cohort: 'users', fiscalYearStartMonth: 2 }), ['Last 6 months vs the 6 before', 'Cohorts: users vs non-users', 'Fiscal year starts in February'])
})

test('a data-flow run finds its analysis only through the ROI trigger', () => {
  assert.equal(roiAnalysisIdOfTrigger({ type: 'manual', source: ROI_DATA_FLOW_SOURCE, roiAnalysisId: 'a1' }), 'a1')
  assert.equal(roiAnalysisIdOfTrigger({ type: 'manual', roiAnalysisId: 'a1' }), null)
  assert.equal(roiAnalysisIdOfTrigger(null), null)
})
