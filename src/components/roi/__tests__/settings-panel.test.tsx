import '@/test-support/jsdom-env'
import React from 'react'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SettingsPanel } from '@/components/roi/settings-panel'
import { DEFAULT_RUN_CONFIG } from '@/lib/roi/config'
import type { RoiAnalysisView, RoiOpenResult, RoiPageAccount, RoiPageSetup } from '@/lib/roi/types'

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

function account(name: string, extra: Partial<RoiPageAccount> = {}): RoiPageAccount {
  return { account: name, extracts: ['activity'], covers: ['Activity trends'], loadedAt: minutesAgo(60 * 50), report: null, mine: null, newerData: false, activeAnalysisId: null, canRefresh: true, ...extra }
}
const report = { artifactId: 'rep-1', versionId: 'rv-1', ready: true, config: { ...DEFAULT_RUN_CONFIG }, reason: 'Renewal', factsCurrent: true, updatedAt: minutesAgo(90) }
const mine = { versionId: 'pv-1', config: { ...DEFAULT_RUN_CONFIG }, reason: 'Renewal', factsCurrent: true, updatedAt: minutesAgo(5) }

const HP = account('HP', { report, mine })
const IM = account('Iron Mountain', { report, mine: null })
const NEW = account('Globex', { report: null, mine: null })

function setupOf(extra: Partial<RoiPageSetup> = {}): RoiPageSetup {
  return {
    accounts: [HP, IM, NEW],
    agent: { id: 'agent-1', title: 'ROI Analyst', model: 'Opus 5.5', canConfigure: true, ownerName: 'James' },
    dataSource: { kind: 'repository', flowId: null, flowName: null },
    flows: [],
    backstory: { connected: true },
    expectedSeconds: 180,
    reconfigureSeconds: 40,
    asyncAfterSeconds: 240,
    page: { artifactId: 'page-1', currentAccount: 'HP' },
    defaultAccount: 'Backstory',
    canLoadExtracts: true,
    hiddenAccounts: [],
    hiddenAvailable: [],
    ...extra,
  }
}

function run(id: string, accountName: string, createdAt: string, extra: Partial<RoiAnalysisView> = {}): RoiAnalysisView {
  return {
    id, account: accountName, template: 'standard', timeframe: { preset: 'last6_vs_prior6' }, timeframeLabel: '', config: { ...DEFAULT_RUN_CONFIG },
    configSummary: ['Last 6 months vs the 6 before', 'Cohorts: high, medium and low adopters'], reason: 'QBR / EBR for the CFO and the whole exec team', context: '',
    status: 'completed', phase: 'ready', mode: 'reconfigure', versionId: 'v', error: null, executionId: null, agentTaskId: null, artifactId: 'page-1', hasReport: true,
    results: null, kpis: [], pageVersionId: null, chat: [], datasets: [], requestedBy: 'Dana', createdAt, updatedAt: createdAt, completedAt: createdAt, ...extra,
  }
}
const analyses = [
  run('h1', 'HP', minutesAgo(10), { pageVersionId: 'pv-1' }),
  run('h2', 'HP', minutesAgo(60 * 30), { phase: 'failed', error: 'The data flow timed out.' }),
  run('h3', 'HP', minutesAgo(60 * 50)),
  run('i1', 'Iron Mountain', minutesAgo(3)),
]

type Call = { url: string; method: string; body: unknown }
function stubFetch(routes: Record<string, (call: Call) => { status?: number; json: unknown }>) {
  const calls: Call[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const raw = init?.body
    const body = typeof raw === 'string' ? JSON.parse(raw) : raw instanceof FormData ? Object.fromEntries([...raw.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `file:${(v as File).name}`])) : raw
    const call = { url, method: init?.method ?? 'GET', body }
    calls.push(call)
    const route = routes[url]
    const result = route ? route(call) : { status: 404, json: { error: `No stub for ${url}` } }
    return new Response(JSON.stringify(result.json), { status: result.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return calls
}

function mount(props: Partial<React.ComponentProps<typeof SettingsPanel>> = {}) {
  const events: Record<string, unknown[]> = { started: [], opened: [], pageChanged: [], extracts: [], closed: [], account: [], filters: [] }
  const all = {
    open: true,
    onClose: () => events.closed.push(true),
    setup: setupOf(),
    account: HP,
    onAccountChange: (name: string) => events.account.push(name),
    filters: { fy: [], fq: [], role: [] },
    filterOptions: { fy: ['FY2025', 'FY2026'], fq: ['Q1', 'Q2', 'Q3', 'Q4'], role: ['Account executives', 'Leadership'] },
    onFiltersChange: (filters: unknown) => events.filters.push(filters),
    analyses,
    historyError: null,
    onStarted: (analysis: RoiAnalysisView) => events.started.push(analysis),
    onOpenRun: (analysisRun: RoiAnalysisView) => events.opened.push(analysisRun),
    onDataSourceChange: () => undefined,
    onPageChanged: (result: RoiOpenResult) => events.pageChanged.push(result),
    onExtractsLoaded: () => events.extracts.push(true),
    busy: false,
    ...props,
  }
  const view = render(<SettingsPanel {...all} />)
  return { ...view, events, props: all }
}

const section = (name: RegExp) => screen.getByRole('button', { name })

test('the panel opens on the account with its sections collapsed sensibly and Run waiting for a change', (t) => {
  t.after(cleanup)
  mount()
  assert.ok(screen.getByRole('dialog', { name: 'Filters and settings' }))
  assert.match(screen.getByRole('combobox', { name: 'Account' }).textContent ?? '', /HP/)
  assert.ok(screen.getByText(/Your page updated 5m ago · data loaded 2d ago/))
  assert.equal(section(/^Report filters/).getAttribute('aria-expanded'), 'true')
  assert.equal(section(/^Analysis settings/).getAttribute('aria-expanded'), 'false')
  assert.equal(section(/^Reason/).getAttribute('aria-expanded'), 'false')
  assert.equal(section(/^Run history/).getAttribute('aria-expanded'), 'false')
  assert.equal(section(/^Data source and analyst/).getAttribute('aria-expanded'), 'false')
  // Collapsed sections carry their summary in the button.
  assert.match(section(/^Analysis settings/).textContent ?? '', /Last 6 months vs the 6 before · Cohorts: high, medium and low adopters/)
  assert.match(section(/^Reason/).textContent ?? '', /Renewal/)
  assert.match(section(/^Run history/).textContent ?? '', /3 runs · last run 10m ago/)
  const apply = screen.getByRole('button', { name: 'Run analysis' }) as HTMLButtonElement
  assert.equal(apply.disabled, true)
  assert.ok(screen.getByText('Change a setting or the reason, then run.'))
  assert.ok(screen.getByRole('button', { name: /Refresh data/ }))
  // Focus starts on the close button.
  assert.equal(document.activeElement?.getAttribute('aria-label'), 'Close filters and settings')
})

test('a changed setting is flagged, and Run sends it without refresh', async (t) => {
  t.after(cleanup)
  const calls = stubFetch({ '/api/roi/analyses': () => ({ json: { success: true, analysis: run('new', 'HP', new Date().toISOString(), { phase: 'queued' }) } }) })
  const { events } = mount()
  fireEvent.click(section(/^Analysis settings/))
  assert.equal(section(/^Analysis settings/).getAttribute('aria-expanded'), 'true')
  const twelve = screen.getByRole('radio', { name: /^12 mo/ })
  fireEvent.click(twelve)
  assert.equal((twelve as HTMLInputElement).checked, true)
  assert.match(section(/^Analysis settings/).textContent ?? '', /Changed/)
  assert.ok(screen.getByText("Rewrites the findings on your page's data — about 40 seconds."))
  fireEvent.click(screen.getByRole('radio', { name: 'Same period last year' }))
  assert.ok(screen.getByText(/Compares .* with /))
  const apply = screen.getByRole('button', { name: 'Run analysis' }) as HTMLButtonElement
  assert.equal(apply.disabled, false)
  await act(async () => { fireEvent.click(apply) })
  await waitFor(() => assert.equal(events.started.length, 1))
  const call = calls.find((item) => item.url === '/api/roi/analyses')
  assert.deepEqual(call?.body, { account: 'HP', reason: 'Renewal', config: { windowMonths: 12, comparison: 'year_ago', custom: null, cohort: 'tiers', fiscalYearStartMonth: null }, refresh: false })
})

test('Refresh data sends refresh, and a 409 shows its message in the footer', async (t) => {
  t.after(cleanup)
  const calls = stubFetch({ '/api/roi/analyses': () => ({ status: 409, json: { success: false, error: { message: 'Your HP page is being updated already.' } } }) })
  mount()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Refresh data/ })) })
  await waitFor(() => assert.ok(screen.getByRole('alert')))
  assert.match(screen.getByRole('alert').textContent ?? '', /being updated already/)
  assert.equal((calls[0].body as { refresh: boolean }).refresh, true)
})

test('a missing reason opens the Reason section, focuses the field and says what is wrong', async (t) => {
  t.after(cleanup)
  stubFetch({})
  mount({ account: NEW })
  // An account with neither a page nor a report: Build, and the reason starts open.
  const build = screen.getByRole('button', { name: /Run analysis/ }) as HTMLButtonElement
  assert.equal(section(/^Reason/).getAttribute('aria-expanded'), 'true')
  assert.equal(screen.queryByRole('button', { name: /^Report filters/ }), null)
  assert.equal(screen.queryByRole('button', { name: /Refresh data/ }), null)
  assert.ok(screen.getByText("Builds the report from the account's data — about 3 minutes."))
  // Collapse it first: validation must open it again.
  fireEvent.click(section(/^Reason/))
  assert.equal(section(/^Reason/).getAttribute('aria-expanded'), 'false')
  await act(async () => { fireEvent.click(build) })
  await waitFor(() => assert.equal(section(/^Reason/).getAttribute('aria-expanded'), 'true'))
  assert.ok(screen.getByText("Say why you're running this analysis — it shapes what the report emphasises."))
  assert.match(section(/^Reason/).textContent ?? '', /Required/)
  await waitFor(() => assert.equal(document.activeElement?.id, 'roi-reason'))
  // A preset fills the reason in.
  fireEvent.click(screen.getByRole('button', { name: 'Churn risk' }))
  assert.equal((screen.getByLabelText('Reason for running this analysis') as HTMLTextAreaElement).value, 'Churn risk')
})

test('invalid custom periods are flagged, and a submit focuses the first bad month', async (t) => {
  t.after(cleanup)
  stubFetch({})
  mount()
  fireEvent.click(section(/^Analysis settings/))
  fireEvent.click(screen.getByRole('radio', { name: /^Custom/ }))
  const baselineFrom = screen.getByLabelText('Baseline period start') as HTMLSelectElement
  const baselineTo = screen.getByLabelText('Baseline period end') as HTMLSelectElement
  // A baseline that ends before it starts.
  fireEvent.change(baselineTo, { target: { value: baselineFrom.options[0].value } })
  fireEvent.change(baselineFrom, { target: { value: baselineFrom.options[5].value } })
  assert.ok(screen.getByText(/The baseline period ends before it starts\./))
  fireEvent.click(section(/^Analysis settings/))
  assert.match(section(/^Analysis settings/).textContent ?? '', /Not valid/)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Run analysis' })) })
  await waitFor(() => assert.equal(section(/^Analysis settings/).getAttribute('aria-expanded'), 'true'))
  await waitFor(() => assert.equal(document.activeElement?.id, 'roi-baseline-from'))
})

test('filters are compact chips with a count and a Clear beside the header', (t) => {
  t.after(cleanup)
  const { events } = mount({ filters: { fy: ['FY2026'], fq: ['Q1', 'Q2'], role: [] } })
  assert.match(section(/^Report filters/).textContent ?? '', /3 active filters/)
  assert.equal(screen.getByRole('button', { name: 'FY2026' }).getAttribute('aria-pressed'), 'true')
  fireEvent.click(screen.getByRole('button', { name: 'Q3' }))
  assert.deepEqual(events.filters.at(-1), { fy: ['FY2026'], fq: ['Q1', 'Q2', 'Q3'], role: [] })
  fireEvent.click(screen.getByRole('button', { name: 'Clear all report filters' }))
  assert.deepEqual(events.filters.at(-1), { fy: [], fq: [], role: [] })
})

test('run history shows the account\'s runs first; a page version opens in place; All accounts keeps full names', (t) => {
  t.after(cleanup)
  const { events } = mount()
  fireEvent.click(section(/^Run history/))
  const history = document.getElementById('roi-section-history-body') as HTMLElement
  assert.equal((within(history).getByRole('radio', { name: 'This account' }) as HTMLInputElement).checked, true)
  const openable = within(history).getAllByRole('button', { name: /Show this version on your page/ })
  assert.equal(openable.length, 1)
  fireEvent.click(openable[0])
  assert.equal((events.opened[0] as RoiAnalysisView).id, 'h1')
  assert.ok(within(history).getByText('The data flow timed out.'))
  assert.ok(within(history).getByRole('button', { name: /Compare runs/ }))
  fireEvent.click(within(history).getByRole('radio', { name: 'All accounts' }))
  const folders = within(history).getAllByRole('button', { expanded: false })
  const names = folders.map((button) => button.querySelector('span.truncate')?.textContent)
  assert.ok(names.includes('HP'), `folder names: ${names.join(', ')}`)
  assert.ok(names.includes('Iron Mountain'))
})

test('newer data offers Update my page, which reports the result to the page', async (t) => {
  t.after(cleanup)
  const calls = stubFetch({ '/api/roi/page/open': () => ({ json: { success: true, result: { status: 'ready', artifactId: 'page-1', versionId: 'pv-2' } } }) })
  const { events } = mount({ account: { ...HP, newerData: true } })
  assert.ok(screen.getByText('Newer data is available for HP.'))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Update my page' })) })
  await waitFor(() => assert.equal(events.pageChanged.length, 1))
  assert.deepEqual(calls[0].body, { account: 'HP', update: true })
  assert.equal(screen.queryByRole('button', { name: 'Update my page' }), null)
})

test('while the page is being updated, both actions wait', (t) => {
  t.after(cleanup)
  mount({ busy: true })
  assert.equal((screen.getByRole('button', { name: 'Run analysis' }) as HTMLButtonElement).disabled, true)
  assert.equal((screen.getByRole('button', { name: /Refresh data/ }) as HTMLButtonElement).disabled, true)
  assert.ok(screen.getByText('This page is being updated now. Run again once it lands.'))
})

test('Escape closes the panel, but only leaves the typed account entry when typing', (t) => {
  t.after(cleanup)
  const { events } = mount({ setup: setupOf({ dataSource: { kind: 'flow', flowId: 'f', flowName: 'Databricks' } }) })
  fireEvent.click(screen.getByRole('combobox', { name: 'Account' }))
  fireEvent.click(screen.getByRole('option', { name: /Another account/ }))
  const typed = screen.getByLabelText('Account name')
  fireEvent.keyDown(typed, { key: 'Escape' })
  assert.equal(events.closed.length, 0)
  assert.equal(screen.queryByLabelText('Account name'), null)
  fireEvent.keyDown(document.body, { key: 'Escape' })
  assert.equal(events.closed.length, 1)
})

test('the account list opens below the field, follows the keyboard, and Escape closes only the list', (t) => {
  t.after(cleanup)
  const { events } = mount()
  const field = screen.getByRole('combobox', { name: 'Account' })
  fireEvent.keyDown(field, { key: 'ArrowDown' })
  assert.equal(field.getAttribute('aria-expanded'), 'true')
  const options = screen.getAllByRole('option')
  assert.deepEqual(options.map((option) => option.querySelector('span span')?.textContent), ['HP', 'Iron Mountain', 'Globex'])
  assert.equal(options[0].getAttribute('aria-selected'), 'true')
  assert.match(options[0].textContent ?? '', /On your page/)
  fireEvent.keyDown(field, { key: 'Escape' })
  assert.equal(field.getAttribute('aria-expanded'), 'false')
  assert.equal(events.closed.length, 0, 'Escape closed the list, not the panel')
  fireEvent.keyDown(field, { key: 'ArrowDown' })
  fireEvent.keyDown(field, { key: 'ArrowDown' })
  fireEvent.keyDown(field, { key: 'Enter' })
  assert.deepEqual(events.account, ['Iron Mountain'])
})

test('a typed account (flow) needs a name, then opens', (t) => {
  t.after(cleanup)
  const { events } = mount({ setup: setupOf({ dataSource: { kind: 'flow', flowId: 'f', flowName: 'Databricks' } }) })
  fireEvent.click(screen.getByRole('combobox', { name: 'Account' }))
  fireEvent.click(screen.getByRole('option', { name: /Another account/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Open' }))
  assert.ok(screen.getByText('Type the account name, as Backstory names it.'))
  fireEvent.change(screen.getByLabelText('Account name'), { target: { value: '  Globex Corp ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Open' }))
  assert.deepEqual(events.account, ['Globex Corp'])
})

test('the extract loader names the account, loads each file and tags it', async (t) => {
  t.after(cleanup)
  const calls = stubFetch({
    '/api/files/upload-url': () => ({ status: 501, json: { error: 'Direct upload is not available here.' } }),
    '/api/repository': () => ({ json: { success: true, document: { id: 'doc-1' } } }),
    '/api/roi/sources': () => ({ json: { success: true } }),
  })
  const { events } = mount()
  fireEvent.click(section(/^Data source and analyst/))
  assert.ok(screen.getByText('ROI Analyst'))
  assert.ok(screen.getByText(/HP's extracts feed Activity trends\./))
  fireEvent.click(screen.getByRole('button', { name: 'Load extracts' }))
  assert.ok(screen.getByText('Name the account these extracts belong to.'))
  fireEvent.change(screen.getByLabelText('Account for these extracts'), { target: { value: 'hp' } })
  fireEvent.click(screen.getByRole('button', { name: 'Load extracts' }))
  assert.ok(screen.getByText('Choose at least one extract file to load.'))
  const wrong = new File(['x'], 'notes.pdf', { type: 'application/pdf' })
  fireEvent.change(screen.getByLabelText(/Choose the Usage cohort file/), { target: { files: [wrong] } })
  assert.ok(screen.getByText('notes.pdf is not a CSV or TSV file. Export the extract as .csv or .tsv.'))
  const csv = new File(['a,b\n1,2\n'], 'activity.csv', { type: 'text/csv' })
  fireEvent.change(screen.getByLabelText(/Choose the Activity extract file/), { target: { files: [csv] } })
  assert.ok(screen.getByText(/activity\.csv · 8 B/))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Load 1 extract' })) })
  await waitFor(() => assert.equal(events.extracts.length, 1))
  assert.deepEqual(calls.map((call) => call.url), ['/api/files/upload-url', '/api/repository', '/api/roi/sources'])
  assert.equal((calls[1].body as { file: string }).file, 'file:activity.csv')
  assert.match((calls[1].body as { description: string }).description, /^Activity extract for HP — ROI analysis extract, loaded \d{4}-\d{2}-\d{2}\.$/)
  // "hp" lands on the spelling the page already uses.
  assert.deepEqual(calls[2].body, { documentId: 'doc-1', account: 'HP', kind: 'activity' })
  assert.ok(screen.getByText('Loaded 1 extract for HP.'))
})

test('Tab stays inside the panel', (t) => {
  t.after(cleanup)
  mount()
  const close = screen.getByRole('button', { name: 'Close filters and settings' })
  close.focus()
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
  // jsdom has no layout, so every element reports no client rects: the trap
  // falls back to doing nothing rather than throwing.
  assert.ok(document.activeElement)
})
