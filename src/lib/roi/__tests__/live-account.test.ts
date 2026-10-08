import test from 'node:test'
import assert from 'node:assert/strict'
import { bucketByFiscalYear, hasLiveData, liveFiscalYears, liveNarrative, parseAccount, parsePeople, parseStatus, summarizeSalesforce, toolData, type RoiLiveAccount } from '../live-account'
import { liveIsStale } from '../personal-page'
import { roiNarrativeSchema } from '../contract'
import { renderRoiDashboard } from '../dashboard'

// Answers in the shape the Backstory MCP returns (from its demo server).
const FIND_ACCOUNT = { content: [{ type: 'text', text: JSON.stringify({ peopleai_account_id: 23890901220, name: 'Hyland Software', domain: 'hyland.com', opportunities: [{ peopleai_opportunity_id: 1, opportunity_name: 'Hyland - Renewal - 448K', amount: 448000, close_date: '2026-11-20', engagement_level: 61, owner: { id: 3, name: 'Mira Lawson' }, type: 'Renewal' }] }) }] }
const STATUS = 'Risks:\n - **Pricing and Value Concerns**: finance is skeptical.\n - **Delayed Discussions**: stakeholders are slow.\nDiscussed topics:\n - Pricing structure.\nNext steps:\n - **Mira Lawson**: Prepare a detailed analysis.\n'
const PEOPLE = '<EngagementSummary timeframe_days="30">\n  <ExternalGroup engaged_count="6" org="External">\n    <MostEngagedParticipant email="s@hyland.com" email_count="6" job_title="Vice President of Sales" last_engaged="2026-09-15" meeting_count="4" name="Steven Smith" />\n    <Participants>\n      <Participant email="a@hyland.com" email_count="15" job_title="Director of Procurement" last_engaged="2026-10-05" meeting_count="2" name="Arthur Gonzalez" />\n    </Participants>\n  </ExternalGroup>\n  <InternalGroup engaged_count="1" org="Keyslogic">\n    <MostEngagedParticipant email="m@k.com" email_count="21" job_title="Account Executive" last_engaged="2026-10-05" meeting_count="6" name="Mira Lawson" />\n    <Participants>\n    </Participants>\n  </InternalGroup>\n</EngagementSummary>'

test('tool answers read as data: structured content, JSON text, plain text', () => {
  assert.deepEqual(toolData({ structuredContent: { result: [1, 2] } }), [1, 2])
  assert.equal((toolData(FIND_ACCOUNT) as { name: string }).name, 'Hyland Software')
  assert.equal(toolData({ content: [{ type: 'text', text: '{"result":"Risks:"}' }] }), 'Risks:')
  assert.equal(toolData({ content: [{ type: 'text', text: 'plain words' }] }), 'plain words')
})

test('the account, its status and who is engaged parse from Backstory\'s answers', () => {
  const account = parseAccount(toolData(FIND_ACCOUNT))!
  assert.equal(account.id, 23890901220)
  assert.deepEqual(account.opportunities[0], { name: 'Hyland - Renewal - 448K', type: 'Renewal', amount: 448000, closeDate: '2026-11-20', engagement: 61, owner: 'Mira Lawson' })
  assert.equal(parseAccount({ result: 'no match' }), null)
  const status = parseStatus(STATUS)!
  assert.equal(status.risks.length, 2)
  assert.match(status.risks[0], /^\*\*Pricing and Value Concerns\*\*/)
  assert.deepEqual(status.topics, ['Pricing structure.'])
  assert.equal(status.nextSteps.length, 1)
  const people = parsePeople(PEOPLE)!
  assert.equal(people.externalCount, 6)
  assert.deepEqual(people.external.map((p) => [p.name, p.title, p.emails, p.meetings]), [['Steven Smith', 'Vice President of Sales', 6, 4], ['Arthur Gonzalez', 'Director of Procurement', 15, 2]])
  assert.equal(people.internal[0].name, 'Mira Lawson')
})

test('Salesforce opportunities summarise into won and lost, by type and fiscal year, and open pipeline', () => {
  const s = summarizeSalesforce([
    { IsClosed: true, IsWon: true, Amount: 100, Type: 'New Business', CloseDate: '2026-03-01', CreatedDate: '2026-01-30T00:00:00.000+0000' },
    { IsClosed: true, IsWon: false, Amount: 50, Type: 'New Business', CloseDate: '2025-12-15', CreatedDate: '2025-10-01T00:00:00.000+0000' },
    { IsClosed: true, IsWon: true, Amount: 300, Type: 'Renewal', CloseDate: '2025-01-20', CreatedDate: '2024-12-01T00:00:00.000+0000' },
    { IsClosed: false, IsWon: false, Amount: 80, StageName: 'Negotiation' },
    { IsClosed: false, IsWon: false, Amount: 20, StageName: 'Negotiation' },
  ], 2)
  assert.equal(s.closedWon, 2)
  assert.equal(s.closedLost, 1)
  assert.equal(s.wonAmount, 400)
  assert.equal(s.avgDaysToClose, Math.round((30 + 50) / 2))
  assert.deepEqual(s.byType[0], { type: 'New Business', won: 1, lost: 1 })
  assert.deepEqual(s.byFy.map((f) => f.fy), ['FY2025', 'FY2026', 'FY2027'], 'fiscal years start in February')
  assert.deepEqual(s.byMonth, [
    { month: '2025-01', won: 1, lost: 0, wonAmount: 300 },
    { month: '2025-12', won: 0, lost: 1, wonAmount: 0 },
    { month: '2026-03', won: 1, lost: 0, wonAmount: 100 },
  ], 'the raw close months are kept, so fiscal years can be bucketed when drawn')
  assert.deepEqual(s.openByStage, [{ stage: 'Negotiation', count: 2, amount: 100 }])
})

test('fiscal years are bucketed from the raw months with whatever fiscal start is in force when drawn', () => {
  const byMonth = [
    { month: '2025-01', won: 1, lost: 0, wonAmount: 300 },
    { month: '2025-12', won: 0, lost: 1, wonAmount: 0 },
    { month: '2026-03', won: 1, lost: 0, wonAmount: 100 },
  ]
  assert.deepEqual(bucketByFiscalYear(byMonth, null).map((f) => [f.fy, f.won, f.lost, f.wonAmount]), [['FY2025', 1, 1, 300], ['FY2026', 1, 0, 100]], 'January: calendar years (December 2025 is FY2025)')
  assert.deepEqual(bucketByFiscalYear(byMonth, 2).map((f) => f.fy), ['FY2025', 'FY2026', 'FY2027'], 'February: the same months, relabelled')
  assert.deepEqual(bucketByFiscalYear(byMonth, 7).map((f) => [f.fy, f.won + f.lost]), [['FY2025', 1], ['FY2026', 2]], 'July: December 2025 and March 2026 share FY2026')
  const sf = { closedWon: 2, closedLost: 1, wonAmount: 400, avgDaysToClose: null, byType: [], byFy: [{ fy: 'FY2026', won: 2, lost: 1, wonAmount: 400 }], openByStage: [] }
  assert.deepEqual(liveFiscalYears(sf, 2), sf.byFy, 'a version read before the months were kept shows what it was bucketed with')
  assert.equal(liveFiscalYears({ ...sf, byMonth }, 2).length, 3)
})

test('a live read under one fiscal start is stale for a page whose settings now say another', () => {
  const now = Date.parse('2026-10-07T21:00:00.000Z')
  const fresh = (fyStartMonth: number | null | undefined): RoiLiveAccount => ({ fetchedAt: '2026-10-07T20:00:00.000Z', sources: [], ...(fyStartMonth === undefined ? {} : { fyStartMonth }) })
  assert.equal(liveIsStale(fresh(null), now, null), false)
  assert.equal(liveIsStale(fresh(2), now, 2), false)
  assert.equal(liveIsStale(fresh(2), now, null), true, 'the settings moved to January')
  assert.equal(liveIsStale(fresh(null), now, 7), true, 'the settings moved to July')
  assert.equal(liveIsStale(fresh(undefined), now, null), false, 'a read from before the start was recorded counts as January')
  assert.equal(liveIsStale(fresh(undefined), now, 4), true)
  assert.equal(liveIsStale(fresh(2), now - 7 * 60 * 60_000, 2), false)
  assert.equal(liveIsStale(fresh(2), now + 7 * 60 * 60_000, 2), true, 'older than the TTL')
})

const live: RoiLiveAccount = {
  fetchedAt: '2026-10-07T20:00:00.000Z',
  scope: 'account',
  sources: [{ name: 'Backstory', ok: true }, { name: 'Salesforce', ok: false, note: 'No Salesforce connection' }],
  account: { name: 'Hyland Software', domain: 'hyland.com' },
  opportunities: [{ name: 'Renewal <448K>', type: 'Renewal', amount: 448000, closeDate: '2026-11-20', engagement: 61, owner: 'Mira' }],
  status: parseStatus(STATUS),
  people: parsePeople(PEOPLE),
}

test('a live-only report has findings from what was read, valid for the report', () => {
  assert.equal(hasLiveData(live), true)
  assert.equal(hasLiveData({ fetchedAt: '', sources: [] }), false)
  const narrative = liveNarrative(live, 'Hyland Software')
  assert.equal(roiNarrativeSchema.safeParse(narrative).success, true)
  assert.ok(narrative.headline.length <= 100)
  assert.match(narrative.findings[0].p, /\*\*1\*\* open opportunities worth \*\*\$448K\*\*/)
  assert.match(narrative.watch[0].text, /Pricing and Value Concerns/)
  assert.deepEqual(narrative.caveats, ['Salesforce could not be read: No Salesforce connection.'])
})

test('the report draws "today" from the live read, escaped, and says where it came from', () => {
  const html = renderRoiDashboard({ U: null, OPP: null, ST: null, META: {}, notes: [] }, liveNarrative(live, 'Hyland Software'), { account: 'Hyland Software', live })
  assert.match(html, /Hyland Software today · live from Backstory/)
  assert.match(html, /Renewal &lt;448K&gt;/)
  assert.match(html, /<span class="eng md">61<\/span>/)
  assert.match(html, /Salesforce: No Salesforce connection/)
  assert.match(html, /<li><b>Pricing and Value Concerns<\/b>: finance is skeptical\.<\/li>/)
  assert.match(html, /it shows on your page and refreshes/, 'the workspace can see the page, so the block never claims to be private')
  assert.doesNotMatch(html, /your page only/)
})

test('the report buckets the live by-fiscal-year table from the run\'s own fiscal start, not the one it was read under', () => {
  const withSf: RoiLiveAccount = {
    ...live,
    fyStartMonth: null,
    sources: [{ name: 'Backstory', ok: true }, { name: 'Salesforce', ok: true }],
    salesforce: {
      closedWon: 2, closedLost: 1, wonAmount: 400, avgDaysToClose: 40, byType: [], openByStage: [],
      byFy: [{ fy: 'FY2025', won: 1, lost: 0, wonAmount: 300 }, { fy: 'FY2026', won: 1, lost: 1, wonAmount: 100 }],
      byMonth: [{ month: '2025-01', won: 1, lost: 0, wonAmount: 300 }, { month: '2025-12', won: 0, lost: 1, wonAmount: 0 }, { month: '2026-03', won: 1, lost: 0, wonAmount: 100 }],
    },
  }
  const facts = { U: null, OPP: null, ST: null, META: {}, notes: [] }
  const narrative = liveNarrative(withSf, 'Hyland Software')
  const january = renderRoiDashboard(facts, narrative, { account: 'Hyland Software', live: withSf, config: { windowMonths: 6, comparison: 'prior', custom: null, cohort: 'tiers', fiscalYearStartMonth: null } })
  assert.match(january, /<td>FY2025<\/td><td>1<\/td><td>1<\/td>/)
  assert.doesNotMatch(january, /FY2027/)
  const february = renderRoiDashboard(facts, narrative, { account: 'Hyland Software', live: withSf, config: { windowMonths: 6, comparison: 'prior', custom: null, cohort: 'tiers', fiscalYearStartMonth: 2 } })
  assert.match(february, /<td>FY2027<\/td><td>1<\/td><td>0<\/td>/, 'March 2026 is FY2027 when the year starts in February')
  assert.match(february, /<td>FY2026<\/td><td>0<\/td><td>1<\/td>/)
})
