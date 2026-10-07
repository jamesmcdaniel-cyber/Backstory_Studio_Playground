import test from 'node:test'
import assert from 'node:assert/strict'
import { extractReadoutData, readoutFacts, readoutNarrative, readoutRoleOf, READOUT_ALL_TYPES, ReadoutFormatError } from '../readout-import'
import { roiNarrativeSchema } from '../contract'
import { renderRoiDashboard } from '../dashboard'
import { popMask, summarizeFacts, winAvg } from '../facts'
import { DEFAULT_RUN_CONFIG, resolveWindows } from '../config'
import { readoutData, readoutHtml } from './readout-fixture'

test('the readout\'s data reads out of its page, JavaScript and all', () => {
  const data = extractReadoutData(readoutHtml()) as { user_list: Array<{ last_active: unknown }>; acct_list_v2: Array<{ account_name: string }> }
  assert.equal(data.user_list[4].last_active, null, 'NaN reads as null')
  assert.equal(data.acct_list_v2[0].account_name, 'Globex {Corp}', 'a brace inside a string does not end the object')
  assert.throws(() => extractReadoutData('<html><body>Nothing here</body></html>'), (error: unknown) => error instanceof ReadoutFormatError && /no embedded data/.test(error.message))
  const partial = { ...readoutData(), decile_stats: undefined }
  assert.throws(() => extractReadoutData(readoutHtml(undefined, partial)), /missing decile_stats/)
})

test('roles come from titles, by the readout\'s own rule', () => {
  assert.equal(readoutRoleOf('Senior Account Executive'), 'Account executives')
  assert.equal(readoutRoleOf('Customer Success Manager'), 'CS / PS')
  assert.equal(readoutRoleOf('Sales Engineer'), 'Solutions engineering')
  assert.equal(readoutRoleOf('Business Development Representative'), 'SDR / BDR')
  assert.equal(readoutRoleOf('VP, Sales'), 'Leadership')
  assert.equal(readoutRoleOf('Staff Engineer'), 'Other')
})

test('the readout becomes facts the report draws: weighted group rows, deal tables, stages, accounts', () => {
  const facts = readoutFacts(extractReadoutData(readoutHtml()))
  const U = facts.U!
  assert.equal(U.months.length, 12)
  assert.deepEqual(U.users.map((u) => [u.k, u.g, u.w]), [
    ['org', 'All reps', 5], ['cohort', 'High adopters', 3], ['cohort', 'Medium adopters', 3], ['cohort', 'Low adopters', 2], ['cohort', 'Non-users', 2],
    ['role', 'Account executives', 2], ['role', 'CS / PS', 2], ['role', 'Leadership', 1],
  ])
  // The team row averages to the readout's own team series.
  const all = winAvg(U, popMask(U, 'all'), [11])
  assert.equal(all.meeting_count, 18 + 11)
  assert.equal(all.n, 5)
  const users = winAvg(U, popMask(U, 'User'), [0])
  assert.equal(Math.round((users.meeting_count as number) * 100) / 100, Math.round(((3 * 30 + 3 * 20 + 2 * 12) / 8) * 100) / 100, 'cohorts weight by their size')
  assert.equal(U.m.dir_vp_exec[0][0], 9 + 4.5 + 1.8)
  // Deals: every type, then each type with enough deals; win rates in percent.
  assert.deepEqual(Object.keys(facts.OPP!), [READOUT_ALL_TYPES, 'New Business', 'Customer Renewal'])
  const allDeals = facts.OPP![READOUT_ALL_TYPES].excl
  assert.equal(allDeals.n, 130)
  assert.equal(allDeals.levels.find((l) => l.level.startsWith('High'))?.win_rate, 60)
  assert.equal(allDeals.deciles.length, 10)
  assert.ok(allDeals.r_win! > 0.9)
  // Roster without emails; accounts with percent win rates; stages in order.
  assert.ok(!JSON.stringify(facts).includes('@example.com'), 'emails are dropped')
  assert.deepEqual(facts.AGG!.roster.map((u) => [u.n, u.r, u.t, u.f]), [['Ada Example', 'Account executives', 'High', 'User'], ['Bo Example', 'CS / PS', 'High', 'User'], ['Cy Example', 'Leadership', 'Medium', 'User'], ['Di Example', 'Account executives', 'Low', 'User'], ['Ed Example', 'CS / PS', null, 'Non-user']])
  assert.equal(facts.ACC!.accounts[0].win_rate, 50)
  assert.equal(facts.AGG!.stages.order.length, 8)
  assert.equal(facts.AGG!.stages.heat.wr[0][0], 10)
  assert.equal(facts.AGG!.deals.monthly[0].fq, 'Q3', 'quarters read as the report names them')
  assert.equal(facts.AGG!.cohortWindows!.l6.High.dir_vp_exec, 162)
  // The facts summary the analyst reads counts people, not rows.
  const summary = summarizeFacts(facts, DEFAULT_RUN_CONFIG) as unknown as { activity: { reps: number; usage: { tierCounts: Record<string, number> } } }
  assert.equal(summary.activity.reps, 5)
  assert.deepEqual(summary.activity.usage.tierCounts, { High: 3, Medium: 3, Low: 2 })
})

test('the narrative carries the readout\'s numbers, and a long hero line never becomes the title', () => {
  const data = extractReadoutData(readoutHtml())
  const facts = readoutFacts(data)
  const short = readoutNarrative(data, 'Backstory', readoutHtml(), facts)
  assert.equal(roiNarrativeSchema.safeParse(short).success, true)
  assert.equal(short.headline, 'Engaged deals win and users build pipeline.')
  assert.match(short.findings[0].p, /\*\*60\.0%\*\*.*\*\*6\.0×\*\*.*\*\*10\.0%\*\*/)
  assert.match(short.lede, /\*\*3\.0×\*\* the meetings of non-users/, 'cohort comparisons use the readout\'s own six-month totals')
  const findingTabs = short.findings.map((f) => f.tab)
  assert.ok(findingTabs.includes('stage') && findingTabs.includes('activity'))
  const long = readoutNarrative(data, 'Backstory', readoutHtml('Backstory users are closing deals faster, reaching more senior buyers, and generating significantly more pipeline than peers who are not using it.'), facts)
  assert.ok(long.headline.length <= 100, long.headline)
  // The activity finding cites the same windows the scorecard shows.
  const win = resolveWindows(facts.U!.months, DEFAULT_RUN_CONFIG)
  const obs = winAvg(facts.U!, popMask(facts.U!, 'all'), win.observation)
  assert.ok(short.findings.some((f) => f.fig === (obs.meeting_count as number).toFixed(1)))
})

test('the report draws a readout: its data, its method, no calculator, the readout\'s caption', () => {
  const data = extractReadoutData(readoutHtml())
  const facts = readoutFacts(data)
  const html = renderRoiDashboard(facts, readoutNarrative(data, 'Backstory', '', facts), { account: 'Backstory', config: DEFAULT_RUN_CONFIG })
  assert.match(html, /const AGG = \{"source":"readout"/)
  assert.match(html, /Where the numbers come from/)
  assert.match(html, /Backstory's value readout/)
  assert.ok(!html.includes('id="capP"'), 'the extract method notes are left out')
  assert.match(html, /Key findings · [^<]*5 reps/)
})
