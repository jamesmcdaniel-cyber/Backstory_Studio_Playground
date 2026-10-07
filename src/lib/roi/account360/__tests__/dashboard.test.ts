import test from 'node:test'
import assert from 'node:assert/strict'
import { renderAccount360Dashboard } from '../dashboard'
import { summarizeAccount360 } from '../facts'
import type { Account360Facts } from '../prep'
import { vendorScripts } from '@/lib/artifacts/vendor-scripts'
import { templatesFor } from '@/lib/roi/sources'
import { artifactToolsFor } from '@/lib/artifacts/tools'

const COHORTS = ['Power Users', 'Frequent Browsers', 'Focused Diggers', 'Light Touch', 'No Engagement']

function facts(overrides: Partial<Account360Facts['META']> = {}): Account360Facts {
  const accounts = [
    { account: 'Globex </script><script>alert(1)</script>', cohort: 'Power Users', unique_sessions: 9, deep_action_ratio: 0.3, unique_users: 3, created_by_month: [4_000_000, 1_000_000, 0], closed_won_by_month: [0, 2_000_000, 0] },
    { account: 'Initech', cohort: 'Frequent Browsers', unique_sessions: 6, deep_action_ratio: 0.05, unique_users: 2, created_by_month: [1_000_000, 0, 0], closed_won_by_month: [0, 0, 500_000] },
    { account: 'Umbrella', cohort: 'No Engagement', unique_sessions: 0, deep_action_ratio: 0, unique_users: 0, created_by_month: [100_000, 0, 0], closed_won_by_month: [0, 0, 0] },
  ]
  return {
    BUNDLE: {
      months: ['2026-03', '2026-04', '2026-05'],
      cohorts_static: COHORTS.map((cohort) => {
        const rows = accounts.filter((a) => a.cohort === cohort)
        const created = rows.reduce((s, a) => s + a.created_by_month.reduce((x, y) => x + y, 0), 0)
        const won = rows.reduce((s, a) => s + a.closed_won_by_month.reduce((x, y) => x + y, 0), 0)
        return { cohort, n: rows.length, avg_created: rows.length ? created / rows.length : 0, avg_closed_won: rows.length ? won / rows.length : 0, total_created: created, total_closed_won: won }
      }),
      accounts,
      whale_names: [],
      dark_names: ['Umbrella'],
      top_users: [{ user: 'a@acme.com', total_events: 20, unique_accounts: 2, unique_sessions: 5 }, { user: 'b@acme.com', total_events: 8, unique_accounts: 1, unique_sessions: 2 }],
      session_median: 6,
      depth_ratio_median: 0.12,
    },
    META: {
      accounts: 3, engaged: 2, noEngagement: 1, clickStart: '2026-02-10', clickEnd: '2026-05-20',
      excludedUsers: [], breadthCutoff: 5, eventsTotal: 120, eventsUsed: 110, usersActive: 7, wonBeyondWindow: 0, lastMonthPartial: true,
      ...overrides,
    },
    notes: [],
  }
}

test('the page is written from the run, not from the HP suite it was ported from', () => {
  const html = renderAccount360Dashboard(facts(), { account: 'Acme', lede: 'Power User accounts carry 50x the pipeline.' })
  assert.match(html, /<title>Acme Account 360 ROI<\/title>/)
  assert.match(html, /Acme Account 360 — engagement to pipeline/)
  assert.match(html, /3 parent accounts · click-stream Feb 10, 2026 – May 20, 2026/)
  assert.match(html, /≥6 sessions <strong>and<\/strong> ≥12\.0% deep-action/)
  assert.match(html, /among the 2 accounts with any recorded engagement/)
  assert.match(html, /May 2026 is a partial month/)
  assert.match(html, /Power User accounts carry 50x the pipeline\./)
  for (const leftover of ['HP ', '@hp.com', 'Jan 15', '91 parent', '15.5%', '$54M', 'Feb 1 reset']) {
    assert.ok(!html.includes(leftover), `no "${leftover}" from the original`)
  }
  assert.ok(!html.includes('(excl.'), 'no exclusion clause when nobody was excluded')
})

test('account names in the data cannot break out of the script block', () => {
  const html = renderAccount360Dashboard(facts(), { account: 'Acme' })
  assert.ok(!html.includes('</script><script>alert(1)'), 'the closing tag is escaped inside the JSON')
  assert.match(html, /Globex \\u003c\/script>/)
})

test('excluded users are named, and Chart.js is served from the platform copy', () => {
  const html = renderAccount360Dashboard(facts({ excludedUsers: ['admin@acme.com'] }), { account: 'Acme' })
  assert.match(html, /excl\. 1 flagged user\)/)
  assert.match(html, /Excluded users: admin@acme\.com\./)
  assert.match(vendorScripts(html), /<script src="\/vendor\/chart\.umd\.js"><\/script>/)
})

test('the summary carries the ratios a headline cites, computed rather than left to the model', () => {
  const summary = summarizeAccount360(facts())
  assert.equal(summary.ratios.powerVsNoEngagementCreated, 50)
  assert.equal(summary.ratios.depthLiftFrequentPct, 400)
  assert.equal(summary.ratios.depthLiftInfrequentPct, null, 'no Light Touch accounts: no ratio, not Infinity')
  assert.deepEqual(summary.accounts, { total: 3, engaged: 2, noEngagement: 1 })
})

test('an account offers the analyses its loaded extracts can run', () => {
  assert.deepEqual(templatesFor({ activity: {}, engagement: {} }), ['standard', 'engagement'])
  assert.deepEqual(templatesFor({ clickstream: {}, accounts: {}, opportunities: {} }), ['standard', 'account360'])
  assert.deepEqual(templatesFor({ clickstream: {}, accounts: {} }), [], 'Account 360 cannot run without the opportunity pull, so neither can the standard report')
  assert.deepEqual(templatesFor({ usage: {}, clickstream: {}, opportunities: {} }), ['standard', 'engagement', 'account360'])
})

test('a page can be rebuilt for another account but is never edited through an ROI view', () => {
  const page = artifactToolsFor('page').map((tool) => tool.name)
  assert.ok(page.includes('start_roi_analysis') && page.includes('list_roi_accounts') && page.includes('edit_artifact'))
  assert.ok(!page.includes('update_roi_dashboard'))
  assert.ok(!artifactToolsFor('document').map((tool) => tool.name).includes('start_roi_analysis'))
})
