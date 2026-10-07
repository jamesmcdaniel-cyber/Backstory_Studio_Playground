import test from 'node:test'
import assert from 'node:assert/strict'
import {
  aboutDuration,
  apiErrorMessage,
  compareRuns,
  formatElapsed,
  groupRunsByAccount,
  hasReasonPreset,
  isRunSettled,
  recentFullMonths,
  runStatus,
  stepStates,
  toggleReasonPreset,
  upsertRun,
  windowsPreview,
} from '../history'
import { DEFAULT_RUN_CONFIG } from '../config'
import type { RoiAnalysisView, RoiRunKpi } from '../types'

function run(id: string, account: string, createdAt: string, extra: Partial<RoiAnalysisView> = {}): RoiAnalysisView {
  return {
    id,
    account,
    template: 'engagement',
    timeframe: { preset: 'last6_vs_prior6' },
    timeframeLabel: 'Last 6 months vs prior 6',
    config: { ...DEFAULT_RUN_CONFIG },
    configSummary: ['Last 6 months vs the 6 before'],
    reason: 'QBR / EBR',
    context: '',
    status: 'completed',
    phase: 'ready',
    error: null,
    executionId: null,
    agentTaskId: null,
    artifactId: `artifact-${id}`,
    hasReport: true,
    results: null,
    kpis: [],
    chat: [],
    datasets: [],
    requestedBy: 'Dana',
    createdAt,
    updatedAt: createdAt,
    completedAt: createdAt,
    ...extra,
  }
}

const kpi = (key: string, label: string, display: string): RoiRunKpi => ({ key, label, value: null, display })

test('history folds runs by account, most recently run first, newest run first inside', () => {
  const folders = groupRunsByAccount([
    run('a1', 'Iron Mountain', '2026-01-10T10:00:00Z'),
    run('b1', 'HP', '2026-03-01T10:00:00Z', { phase: 'failed' }),
    run('a2', ' iron mountain ', '2026-05-02T10:00:00Z'),
    run('a3', 'Iron Mountain', '2025-11-02T10:00:00Z', { phase: 'writing' }),
  ])
  assert.deepEqual(folders.map((folder) => folder.account), ['iron mountain', 'HP'])
  assert.deepEqual(folders[0].runs.map((item) => item.id), ['a2', 'a1', 'a3'])
  assert.equal(folders[0].lastRunAt, '2026-05-02T10:00:00Z')
  assert.equal(folders[0].completed, 2)
  assert.equal(folders[1].completed, 0)
})

test('the account search keeps matching folders, ignoring case', () => {
  const analyses = [run('a1', 'Iron Mountain', '2026-01-10T10:00:00Z'), run('b1', 'HP', '2026-03-01T10:00:00Z')]
  assert.deepEqual(groupRunsByAccount(analyses, '  MOUNT ').map((folder) => folder.account), ['Iron Mountain'])
  assert.deepEqual(groupRunsByAccount(analyses, 'nobody'), [])
  assert.equal(groupRunsByAccount(analyses, '').length, 2)
})

test('the comparison puts completed runs oldest first and their numbers in rows', () => {
  const comparison = compareRuns([
    run('new', 'HP', '2026-09-01T00:00:00Z', { kpis: [kpi('win', 'Win rate (engaged)', '49%'), kpi('mtg', 'Senior meetings', '+52%')] }),
    run('running', 'HP', '2026-10-01T00:00:00Z', { phase: 'computing', kpis: [kpi('win', 'x', '1%')] }),
    run('old', 'HP', '2025-09-01T00:00:00Z', { kpis: [kpi('win', 'Win rate', '41%'), kpi('pipe', 'Pipeline created', '$4.1M')] }),
  ])
  assert.deepEqual(comparison.runs.map((item) => item.id), ['old', 'new'])
  assert.deepEqual(comparison.rows, [
    { key: 'win', label: 'Win rate (engaged)', cells: ['41%', '49%'] },
    { key: 'mtg', label: 'Senior meetings', cells: [null, '+52%'] },
    { key: 'pipe', label: 'Pipeline created', cells: ['$4.1M', null] },
  ])
})

test('a comparison of runs without headline numbers has no rows', () => {
  const comparison = compareRuns([run('a', 'HP', '2026-01-01T00:00:00Z'), run('b', 'HP', '2026-02-01T00:00:00Z')])
  assert.equal(comparison.runs.length, 2)
  assert.deepEqual(comparison.rows, [])
})

test('upsert replaces a run in place or puts a new one first', () => {
  const list = [run('a', 'HP', '2026-01-01T00:00:00Z'), run('b', 'HP', '2026-02-01T00:00:00Z')]
  const replaced = upsertRun(list, run('b', 'HP', '2026-02-01T00:00:00Z', { phase: 'failed' }))
  assert.deepEqual(replaced.map((item) => `${item.id}:${item.phase}`), ['a:ready', 'b:failed'])
  assert.deepEqual(upsertRun(list, run('c', 'HP', '2026-03-01T00:00:00Z')).map((item) => item.id), ['c', 'a', 'b'])
  assert.equal(list[1].phase, 'ready')
})

test('the stepper marks finished, current and upcoming steps', () => {
  assert.deepEqual(stepStates('queued'), ['pending', 'pending', 'pending', 'pending'])
  assert.deepEqual(stepStates('computing'), ['done', 'active', 'pending', 'pending'])
  assert.deepEqual(stepStates('building'), ['done', 'done', 'done', 'active'])
  assert.deepEqual(stepStates('ready'), ['done', 'done', 'done', 'done'])
  assert.deepEqual(stepStates('failed'), ['pending', 'pending', 'pending', 'pending'])
  assert.equal(isRunSettled('ready'), true)
  assert.equal(isRunSettled('failed'), true)
  assert.equal(isRunSettled('writing'), false)
  assert.deepEqual(runStatus('writing'), { label: 'Running', tone: 'info' })
  assert.deepEqual(runStatus('failed'), { label: 'Failed', tone: 'risk' })
})

test('the month list is the last full months, ending last month, across a year boundary', () => {
  const months = recentFullMonths(new Date(2026, 0, 15))
  assert.equal(months.length, 24)
  assert.equal(months[0], '2024-01')
  assert.equal(months[23], '2025-12')
  assert.deepEqual(recentFullMonths(new Date(2026, 9, 7), 3), ['2026-07', '2026-08', '2026-09'])
})

test('the windows preview reads the counted-back and custom windows in words', () => {
  const months = recentFullMonths(new Date(2026, 9, 7))
  assert.equal(windowsPreview(DEFAULT_RUN_CONFIG, months), 'Compares Apr – Sep 2026 with Oct 2025 – Mar 2026')
  assert.equal(windowsPreview({ ...DEFAULT_RUN_CONFIG, comparison: 'year_ago' }, months), 'Compares Apr – Sep 2026 with Apr – Sep 2025')
  assert.equal(
    windowsPreview({ ...DEFAULT_RUN_CONFIG, custom: { baseline: { from: '2025-01', to: '2025-03' }, observation: { from: '2026-01', to: '2026-06' } } }, months),
    'Compares Jan – Jun 2026 with Jan – Mar 2025',
  )
  assert.equal(windowsPreview(DEFAULT_RUN_CONFIG, []), 'The chosen months fall outside the data this page can reach.')
})

test('durations read in words and as a clock', () => {
  assert.equal(aboutDuration(90), 'a minute and a half')
  assert.equal(aboutDuration(60), 'a minute')
  assert.equal(aboutDuration(30), '30 seconds')
  assert.equal(aboutDuration(300), '5 minutes')
  assert.equal(formatElapsed(42), '0:42')
  assert.equal(formatElapsed(125.9), '2:05')
  assert.equal(formatElapsed(-3), '0:00')
})

test('an API error reads from either error shape, else the fallback', () => {
  assert.equal(apiErrorMessage({ success: false, error: 'Pick an account.' }, 'fallback'), 'Pick an account.')
  assert.equal(apiErrorMessage({ success: false, error: { message: 'Too many runs today.' } }, 'fallback'), 'Too many runs today.')
  assert.equal(apiErrorMessage({ error: '' }, 'fallback'), 'fallback')
  assert.equal(apiErrorMessage(null, 'fallback'), 'fallback')
})

test('reason presets are added and removed as comma-separated parts', () => {
  assert.equal(toggleReasonPreset('', 'Renewal'), 'Renewal')
  assert.equal(toggleReasonPreset('Renewal', 'QBR / EBR'), 'Renewal, QBR / EBR')
  assert.equal(toggleReasonPreset('Renewal, QBR / EBR', 'renewal'), 'QBR / EBR')
  assert.equal(toggleReasonPreset('CFO asked for proof', 'Renewal'), 'CFO asked for proof, Renewal')
  assert.equal(hasReasonPreset('CFO asked, Renewal', 'Renewal'), true)
  assert.equal(hasReasonPreset('Renewal coming up', 'Renewal'), false)
})
