import test from 'node:test'
import assert from 'node:assert/strict'
import { applyOperations, describeView, EMPTY_VIEW, readView, roiOperationSchema } from '../view'
import { renderRoiDashboard } from '../dashboard'
import type { RoiNarrative } from '../contract'
import type { RoiFacts } from '../prep'

const narrative: RoiNarrative = {
  headline: 'Engaged deals win twice as often.',
  lede: 'Win rate climbs with engagement.',
  findings: [
    { fig: '2.0×', cap: 'win rate', h: 'Engaged deals win', p: 'High 49% vs low 25%.', tab: 'deal' },
    { fig: '+52%', cap: 'senior meetings', h: 'Users meet senior buyers', p: '9.1 vs 6.0.', tab: 'users' },
  ],
  watch: [{ lead: 'Senior access is slipping.', text: '-7.7%.' }, { lead: 'Correlation.', text: 'Users self-select.' }],
  notes: {},
  caveats: [],
}

const context = { metricKeys: ['meeting_count', 'dir_vp_exec', 'pipeline_created'], activityColumns: ['meeting_count', 'accounts_touched', 'accounts_met_with'] }

const facts: RoiFacts = {
  U: {
    months: ['2026-01', '2026-02'],
    users: [{ t: null, f: null, g: '' }],
    m: { meeting_count: [[1, 2]], dir_vp_exec: [[3, 4]], pipeline_created: [[100, 200]] },
    labels: { meeting_count: 'Meetings', dir_vp_exec: 'Director + VP + Exec meetings', pipeline_created: 'Pipeline created' },
    tierCuts: [], nUsage: 0, nBottom: 0, hasUsage: false, usageRecords: 0,
  },
  OPP: null,
  ST: null,
  META: {},
  notes: [],
}

test('a request becomes applied edits; unknown targets are rejected with a reason, the rest still apply', () => {
  const result = applyOperations({ view: EMPTY_VIEW, narrative }, [
    { op: 'hide_tab', tab: 'adopt' },
    { op: 'hide_metric', metric: 'pipeline_created' },
    { op: 'rename_metric', metric: 'meeting_count', label: 'Customer meetings' },
    { op: 'hide_metric', metric: 'bookings' },
    { op: 'hide_section', section: 'calculator' },
    { op: 'hide_section', section: 'nonsense' },
    { op: 'remove_finding', index: 0 },
  ], context)
  assert.deepEqual(result.view.hiddenTabs, ['adopt'])
  assert.deepEqual(result.view.hiddenMetrics, ['pipeline_created'])
  assert.equal(result.view.metricLabels.meeting_count, 'Customer meetings')
  assert.deepEqual(result.view.hiddenSections, ['calculator'])
  assert.equal(result.narrative.findings.length, 1)
  assert.equal(result.narrative.findings[0].h, 'Users meet senior buyers')
  assert.equal(result.applied.length, 5)
  assert.equal(result.rejected.length, 2)
  assert.match(result.rejected.join(' '), /No metric "bookings"/)
  assert.match(result.rejected.join(' '), /No section "nonsense"/)
  assert.equal(result.recompute, false)
})

test('adding a metric needs real columns and asks for a recompute', () => {
  const ok = applyOperations({ view: EMPTY_VIEW, narrative }, [{ op: 'add_metric', metric: { key: 'accounts_touched', label: 'Accounts touched', columns: ['accounts_touched'], format: 'count' } }], context)
  assert.equal(ok.recompute, true)
  assert.equal(ok.view.extraMetrics[0].key, 'accounts_touched')
  const bad = applyOperations({ view: EMPTY_VIEW, narrative }, [{ op: 'add_metric', metric: { key: 'wins', label: 'Wins', columns: ['won_count'], format: 'count' } }], context)
  assert.equal(bad.recompute, false)
  assert.match(bad.rejected[0], /no column won_count/)
  const clash = applyOperations({ view: EMPTY_VIEW, narrative }, [{ op: 'add_metric', metric: { key: 'meeting_count', label: 'x', columns: ['meeting_count'], format: 'count' } }], context)
  assert.match(clash.rejected[0], /already a metric/)
})

test('the last finding cannot be removed and every tab cannot be hidden', () => {
  const one = { ...narrative, findings: [narrative.findings[0]] }
  assert.match(applyOperations({ view: EMPTY_VIEW, narrative: one }, [{ op: 'remove_finding', index: 0 }], context).rejected[0], /at least one finding/)
  const all = applyOperations({ view: EMPTY_VIEW, narrative }, ['lead', 'adopt', 'users', 'deal', 'stage', 'method'].map((tab) => ({ op: 'hide_tab' as const, tab: tab as 'lead' })), context)
  assert.ok(all.view.hiddenTabs.length < 6)
  assert.match(all.rejected.join(' '), /At least one tab/)
})

test('operations from the model are validated before anything applies', () => {
  assert.equal(roiOperationSchema.safeParse({ op: 'hide_tab', tab: 'lead' }).success, true)
  assert.equal(roiOperationSchema.safeParse({ op: 'hide_tab', tab: 'everything' }).success, false)
  assert.equal(roiOperationSchema.safeParse({ op: 'drop_table', table: 'users' }).success, false)
  assert.equal(roiOperationSchema.safeParse({ op: 'add_metric', metric: { key: 'Bad Key', label: 'x', columns: ['a'] } }).success, false)
})

test('the page renders the view: hidden metrics are gone from the data, labels and sections apply', () => {
  const view = readView({ hiddenMetrics: ['pipeline_created'], metricLabels: { meeting_count: 'Customer meetings' }, hiddenSections: ['calculator', 'watch'], hiddenTabs: ['method'], defaultComparison: 'last6_vs_year_ago' })
  const html = renderRoiDashboard(facts, narrative, { account: 'Acme', view })
  const data = /const U = (.*);\n/.exec(html)![1]
  assert.doesNotMatch(data, /pipeline_created/)
  assert.match(data, /"meeting_count":"Customer meetings"/)
  assert.match(html, /\[data-section="calculator"\]\{display:none!important\}/)
  assert.match(html, /\[data-section="watch"\]\{display:none!important\}/)
  assert.match(html, /const VIEW = \{"hiddenTabs":\["method"\]\}/)
  assert.match(html, /const PRESET = "last6_vs_year_ago"/)
})

test('the assistant is told what it can edit', () => {
  const described = describeView(readView({ hiddenMetrics: ['pipeline_created'] }), facts.U!.labels) as { metrics: Array<{ key: string; hidden: boolean }>; sections: unknown[]; tabs: unknown[] }
  assert.equal(described.metrics.find((m) => m.key === 'pipeline_created')?.hidden, true)
  assert.ok(described.sections.length >= 18)
  assert.equal(described.tabs.length, 6)
})
