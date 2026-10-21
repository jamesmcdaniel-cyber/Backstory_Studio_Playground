import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM, VirtualConsole } from 'jsdom'
import { readoutFacts, readoutNarrative } from '../readout-import'
import { renderRoiDashboard } from '../dashboard'
import type { RoiFacts } from '../prep'
import { readoutData } from './readout-fixture'

type Win = JSDOM['window'] & { Plotly: unknown }

/**
 * The report's own script, run in jsdom as the ROI page hosts it: a parent
 * window that receives its messages, a Plotly that keeps what it was asked to
 * draw, and the panel's filters sent the way report-frame.tsx sends them.
 * The fixture's fiscal year starts in February: Aug 25 – Jan 26 is FY2026,
 * Feb – Jul 26 is FY2027, and every metric climbs month by month.
 */
function hostedReport(data = readoutData()) {
  const facts = readoutFacts(data)
  return hostedPage(renderRoiDashboard(facts, readoutNarrative(data, 'Backstory', '', facts), { account: 'Backstory' }))
}

function hostedPage(html: string) {
  const sent: Array<{ type: string }> = []
  const parent = { postMessage: (message: { type: string }) => sent.push(message) }
  const errors: string[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => errors.push(error.message))
  const dom = new JSDOM(html, {
    virtualConsole,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as unknown as Win
      Object.defineProperty(window, 'parent', { value: parent, configurable: true })
      w.Plotly = { react: () => Promise.resolve(), relayout: () => Promise.resolve(), purge: () => {}, Plots: { resize: () => {} }, Fx: { hover: () => {}, unhover: () => {} }, downloadImage: () => {} }
      window.matchMedia = (() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia
      window.HTMLElement.prototype.scrollIntoView = () => {}
    },
  })
  const { window } = dom
  window.dispatchEvent(new window.Event('load'))
  const send = (message: unknown) => {
    const event = new window.MessageEvent('message', { data: message })
    Object.defineProperty(event, 'source', { value: parent })
    window.dispatchEvent(event)
  }
  send({ type: 'backstory:roi-host' })
  const text = (selector: string) => window.document.querySelector(selector)?.textContent ?? ''
  const drawn = (id: string) => (window.document.getElementById(id) as unknown as { _roi?: { data: Array<{ x?: unknown[]; y?: unknown[] }>; layout: { shapes?: Array<{ type: string; x0: number; x1: number }> } } })._roi
  const chart = (id: string) => drawn(id)?.data ?? []
  const filter = (filters: { fy?: string[]; fq?: string[]; role?: string[] }) => send({ type: 'backstory:roi-filters', filters: { fy: [], fq: [], role: [], ...filters } })
  const tab = async (name: string) => {
    send({ type: 'backstory:roi-tab', tab: name })
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)))
  }
  return { window, sent, errors, text, drawn, chart, filter, tab }
}

test('the hosted report offers the readout\'s fiscal years, quarters and roles', () => {
  const report = hostedReport()
  const ready = report.sent.find((message) => message.type === 'backstory:roi-ready') as unknown as { options: { fy: string[]; fq: string[]; role: string[] } }
  assert.equal(JSON.stringify(ready.options.fy), '["FY2026","FY2027"]', 'the readout\'s own fiscal years')
  assert.equal(JSON.stringify(ready.options.fq), '["Q1","Q2","Q3","Q4"]')
  assert.ok(ready.options.role.includes('Account executives'))
})

test('a fiscal year sets the summary\'s window: the scorecard compares that year with the one before', () => {
  const report = hostedReport()
  const before = report.text('#scoreKpis')
  assert.match(report.text('#scoreWin'), /Feb 26 – Jul 26 vs Aug 25 – Jan 26/)
  report.filter({ fy: ['FY2026'] })
  assert.match(report.text('#scoreWin'), /FY2026 \(Aug 25 – Jan 26\)/)
  assert.notEqual(report.text('#scoreKpis'), before, 'the tiles are re-read over the fiscal year')
  report.filter({})
  assert.equal(report.text('#scoreKpis'), before, 'clearing the filter restores the configured windows')
})

test('a fiscal year slices the hero\'s deal deciles and its tiles', () => {
  const report = hostedReport()
  const before = JSON.stringify(report.chart('heroStrip')[0]?.y)
  const stats = report.text('#heroStats')
  report.filter({ fy: ['FY2026'] })
  assert.notEqual(JSON.stringify(report.chart('heroStrip')[0]?.y), before)
  assert.match(report.text('#heroCap'), /FY2026/)
  assert.notEqual(report.text('#heroStats'), stats)
})

test('fiscal year and quarter set the activity windows; the trend highlights only those months', async () => {
  const report = hostedReport()
  await report.tab('activity')
  const before = report.text('#leadDyn')
  report.filter({ fy: ['FY2027'], fq: ['Q1'] })
  const dyn = report.text('#leadDyn')
  assert.notEqual(dyn, before)
  assert.match(report.text('#leadTblSub'), /FY2027 Q1 \(Feb 26 – Apr 26\)/)
  // Feb–Apr 26 (months 6–8): meeting_count 18+i averages 25 for the team.
  assert.match(report.text('#leadTbl'), /Meetings[^\n]*25\.0/)
  const bands = (report.drawn('leadTrend')?.layout.shapes ?? []).filter((shape) => shape.type === 'rect')
  assert.equal(JSON.stringify(bands.map((band) => [band.x0, band.x1])), '[[5.5,8.5]]', 'the observation band covers Feb–Apr 26 only (no earlier year in the fixture)')
  const modes = [...report.window.document.querySelectorAll<HTMLButtonElement>('#leadMode button')]
  assert.ok(modes.length > 0 && modes.every((button) => button.disabled), 'the comparison buttons step aside while the filters set the windows')
  report.filter({})
  assert.ok(modes.every((button) => !button.disabled))
})

test('quarters in two fiscal years compare each with the year before, one band per run of months', async () => {
  const report = hostedReport()
  await report.tab('activity')
  report.filter({ fy: ['FY2026', 'FY2027'], fq: ['Q3'] })
  // FY2026 Q3 = Aug–Oct 25 (months 0–2), FY2027 Q3 = Aug–Oct 26 (beyond the data): one run.
  const bands = (report.drawn('leadTrend')?.layout.shapes ?? []).filter((shape) => shape.type === 'rect')
  assert.equal(JSON.stringify(bands.map((band) => [band.x0, band.x1])), '[[-0.5,2.5]]')
  report.filter({ fy: ['FY2026'], fq: ['Q3', 'Q4'] })
  assert.match(report.text('#leadTblSub'), /FY2026 Q3, Q4 \(Aug 25 – Jan 26\)/)
})

test('every tab draws under every filter without a script error', async () => {
  const report = hostedReport()
  for (const filters of [{ fy: ['FY2026'] }, { fq: ['Q2'] }, { fy: ['FY2027'], fq: ['Q1', 'Q2'], role: ['CS / PS'] }, { role: ['Leadership'] }, {}]) {
    report.filter(filters)
    for (const name of ['summary', 'activity', 'adoption', 'deals', 'stage', 'method']) await report.tab(name)
  }
  assert.deepEqual(report.errors, [])
})

test('reports saved before the readout kept its month map read fiscal periods from its deal months', () => {
  const facts = readoutFacts(readoutData())
  delete facts.AGG!.periods
  const report = hostedPage(renderRoiDashboard(facts, readoutNarrative(readoutData(), 'Backstory', '', facts), { account: 'Backstory' }))
  report.filter({ fy: ['FY2026'] })
  assert.match(report.text('#scoreWin'), /FY2026 \(Aug 25 – Jan 26\)/)
})

test('rep-level reports slice by the configured fiscal year (calendar years when none is set)', () => {
  const facts: RoiFacts = {
    U: {
      months: ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12'],
      users: [{ t: null, f: null, g: 'East' }, { t: null, f: null, g: 'West' }],
      m: { meeting_count: [[1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4], [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]] },
      labels: { meeting_count: 'Meetings' },
      tierCuts: [], nUsage: 0, nBottom: 0, hasUsage: false, usageRecords: 0,
    },
    OPP: null,
    ST: null,
    META: { hasVelocity: false },
    notes: [],
  }
  const narrative = { headline: 'Meetings rose.', lede: 'Meetings rose.', findings: [{ fig: '+1', cap: 'meetings', h: 'Meetings rose', p: 'They did.', tab: 'activity' }], watch: [], notes: {}, caveats: [] }
  const report = hostedPage(renderRoiDashboard(facts, narrative as never, { account: 'Acme' }))
  report.filter({ fy: ['FY2026'], fq: ['Q2'] })
  assert.match(report.text('#scoreWin'), /FY2026 Q2 \(Apr 26 – Jun 26\)/)
  assert.match(report.text('#scoreKpis'), /2\.00/, 'Apr–Jun averages 2 meetings per rep')
  report.filter({ fq: ['Q4'] })
  assert.match(report.text('#scoreKpis'), /4\.00/, 'a quarter alone reads the latest fiscal year that has it')
  assert.deepEqual(report.errors, [])
})

test('a role narrows the scorecard to that role\'s reps', () => {
  const report = hostedReport()
  const before = report.text('#scoreKpis')
  report.filter({ role: ['Account executives'] })
  assert.notEqual(report.text('#scoreKpis'), before)
  assert.match(report.text('#scoreWin'), /Account executives/)
})
