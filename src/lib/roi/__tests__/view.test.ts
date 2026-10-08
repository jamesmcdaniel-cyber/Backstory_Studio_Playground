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
    { fig: '2.0×', cap: 'win rate', h: 'Engaged deals win', p: 'High 49% vs low 25%.', tab: 'deals' },
    { fig: '+52%', cap: 'senior meetings', h: 'Users meet senior buyers', p: '9.1 vs 6.0.', tab: 'adoption' },
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
    { op: 'hide_tab', tab: 'adoption' },
    { op: 'hide_metric', metric: 'pipeline_created' },
    { op: 'rename_metric', metric: 'meeting_count', label: 'Customer meetings' },
    { op: 'hide_metric', metric: 'bookings' },
    { op: 'hide_section', section: 'calculator' },
    { op: 'hide_section', section: 'nonsense' },
    { op: 'remove_finding', index: 0 },
  ], context)
  assert.deepEqual(result.view.hiddenTabs, ['adoption'])
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
  const all = applyOperations({ view: EMPTY_VIEW, narrative }, ['activity', 'adoption', 'deals', 'stage', 'accounts', 'method'].map((tab) => ({ op: 'hide_tab' as const, tab: tab as 'activity' })), context)
  assert.ok(all.view.hiddenTabs.length < 6)
  assert.match(all.rejected.join(' '), /At least one tab/)
})

test('operations from the model are validated before anything applies', () => {
  assert.equal(roiOperationSchema.safeParse({ op: 'hide_tab', tab: 'activity' }).success, true)
  // Ids from the Iron Mountain layout still work, mapped onto the value readout's tabs.
  assert.deepEqual(roiOperationSchema.parse({ op: 'hide_tab', tab: 'deal' }), { op: 'hide_tab', tab: 'deals' })
  assert.deepEqual(roiOperationSchema.parse({ op: 'hide_tab', tab: 'lead' }), { op: 'hide_tab', tab: 'activity' })
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
  assert.match(html, /const VIEW = \{"hiddenTabs":\["method"\],"charts":\{\},"sectionTitles":\{\}\}/)
  assert.match(html, /const CFG = \{[^\n]*"comparison":"year_ago"/)
})

test('a view saved under an earlier layout reads back onto the value readout\'s tabs', () => {
  // Hiding "users" alone hid one Iron Mountain tab; it is a view of Adoption impact now, so it hides nothing.
  const view = readView({ hiddenTabs: ['users', 'lead', 'deal'], hiddenSections: ['activityTiles', 'cohortTable', 'usersLift'] })
  assert.deepEqual(view.hiddenTabs, ['activity', 'deals'])
  assert.deepEqual(view.hiddenSections, ['leadTable', 'adoptTable', 'usersLift'])
})

test('the assistant is told what it can edit', () => {
  const described = describeView(readView({ hiddenMetrics: ['pipeline_created'] }), facts.U!.labels) as { metrics: Array<{ key: string; hidden: boolean }>; sections: unknown[]; tabs: unknown[] }
  assert.equal(described.metrics.find((m) => m.key === 'pipeline_created')?.hidden, true)
  assert.ok(described.sections.length >= 40)
  assert.equal(described.tabs.length, 6)
})

test('the look, the charts and added sections are edited through the same operations, with unsafe content refused', () => {
  const result = applyOperations({ view: EMPTY_VIEW, narrative }, [
    { op: 'set_style', style: { accent: '#2A7D4F', series: ['#2A7D4F', '#82406A'], density: 'compact' } },
    { op: 'set_style', style: { css: '@import url(https://evil.example/x.css);' } },
    { op: 'set_chart', chart: 'dealWin', options: { kind: 'line', labels: false, title: 'Win rate by decile' } },
    { op: 'set_chart', chart: 'noSuchChart', options: { kind: 'bar' } },
    { op: 'add_section', customSection: { id: 'exec-note', tab: 'summary', title: 'For the QBR', html: '<p>Three things to say.</p>', position: 'start' } },
    { op: 'add_section', customSection: { id: 'bad', tab: 'summary', title: 'x', html: '<p onclick="steal()">hi</p>' } },
    { op: 'add_section', customSection: { id: 'worse', tab: 'deals', title: 'x', html: '<script>alert(1)</script>' } },
    { op: 'set_section_title', section: 'dealVel', title: 'How fast engaged deals close' },
    { op: 'set_section_title', section: 'nope', title: 'x' },
  ], context)
  assert.deepEqual(result.view.style, { accent: '#2A7D4F', series: ['#2A7D4F', '#82406A'], density: 'compact' }, 'the unsafe style sheet was refused without losing the rest')
  assert.deepEqual(result.view.charts, { dealWin: { kind: 'line', labels: false, title: 'Win rate by decile' } })
  assert.deepEqual(result.view.sections.map((section) => section.id), ['exec-note'])
  assert.deepEqual(result.view.sectionTitles, { dealVel: 'How fast engaged deals close' })
  assert.equal(result.rejected.length, 5)
  assert.match(result.rejected.join(' '), /import/)
  assert.match(result.rejected.join(' '), /No chart "noSuchChart"/)
  assert.match(result.rejected.join(' '), /event handlers/)
  assert.match(result.rejected.join(' '), /no script/)
  assert.match(result.rejected.join(' '), /No section "nope"/)
  // the same id rewrites a section; remove takes it away; reset_style clears the look
  const again = applyOperations({ view: result.view, narrative }, [
    { op: 'add_section', customSection: { id: 'exec-note', tab: 'summary', title: 'For the QBR, revised', html: '<p>Two things.</p>' } },
    { op: 'remove_section', id: 'missing' },
    { op: 'reset_chart', chart: 'dealWin' },
    { op: 'reset_style' },
  ], context)
  assert.equal(again.view.sections.length, 1)
  assert.equal(again.view.sections[0].title, 'For the QBR, revised')
  assert.notEqual(again.view.sections[0].position, 'start', 'the rewrite without a position goes to the end of the tab')
  assert.equal(again.view.style, undefined)
  assert.deepEqual(again.view.charts, {})
  assert.match(again.rejected[0], /No added section "missing"/)
  assert.equal(roiOperationSchema.safeParse({ op: 'set_style', style: { accent: 'green' } }).success, false, 'colours are hex')
  assert.equal(roiOperationSchema.safeParse({ op: 'add_section', customSection: { id: 'Bad Id', tab: 'summary', title: 'x', html: '<p>x</p>' } }).success, false)
  const described = describeView(result.view, facts.U!.labels) as { charts: Array<{ chart: string; options?: unknown }>; addedSections: Array<{ id: string; htmlChars: number }>; style: unknown }
  assert.ok(described.charts.find((chart) => chart.chart === 'dealWin')?.options)
  assert.equal(described.addedSections[0].htmlChars, '<p>Three things to say.</p>'.length)
})

test('the page renders the look, the chart options and the added sections', () => {
  const view = readView({
    style: { accent: '#2A7D4F', series: ['#2A7D4F'], density: 'compact', css: '.fcard{border-radius:0}</style><script>x()</script>' },
    charts: { dealWin: { kind: 'line', labels: false } },
    sections: [{ id: 'exec-note', tab: 'summary', title: 'For the QBR', html: '<p>Three things <b>to say</b>.</p>', position: 'start' }, { id: 'method-note', tab: 'method', title: 'Data notes', html: '<ul><li>One</li></ul>' }],
    sectionTitles: { dealVel: 'How fast engaged deals close' },
  })
  const html = renderRoiDashboard(facts, narrative, { account: 'Acme', view })
  assert.match(html, /<style id="roiCustomStyle">:root,:root\[data-theme="dark"\]\{--horizon:#2A7D4F;--horizon-deep:#2A7D4F;--s1:#2A7D4F\}/)
  assert.match(html, /\.chart\{height:320px\}/, 'compact density')
  assert.ok(html.includes('.fcard{border-radius:0}<\\/style><script>x()</script>'), 'a style sheet cannot close the style tag early')
  assert.ok(html.indexOf('data-custom="exec-note"') < html.indexOf('id="findings"'), 'a start section sits before the findings')
  assert.ok(html.includes('<h3>For the QBR</h3><div class="custom-body"><p>Three things <b>to say</b>.</p></div>'))
  assert.ok(html.indexOf('data-custom="method-note"') > html.indexOf('id="p-method"'))
  assert.match(html, /const VIEW = \{"hiddenTabs":\[\],"charts":\{"dealWin":\{"kind":"line","labels":false\}\},"sectionTitles":\{"dealVel":"How fast engaged deals close"\}\}/)
})
