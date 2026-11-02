import test from 'node:test'
import assert from 'node:assert/strict'
import {
  dealTypeOf,
  fiscalQuarters,
  inferFiscalStart,
  internalWithTitle,
  CSM_TITLE,
  SE_TITLE,
  isoDate,
  mcpText,
  parseAccountOpportunities,
  parseEngagedPeople,
  parseOpenDeals,
} from '../pipeline'

/** Shapes captured from the Backstory MCP on the demo tenant, 2026-11-02. */
const FETCH_RECORDS = {
  object_type: 'opportunity',
  records: [
    { peopleai_opportunity_id: 5568994124, name: 'Abacus - New Business - 262K', account_id: 23904725414, account_name: 'Abacus', ootb_opportunity_close_date: 'Mar 02, 2027', ootb_opportunity_amount: 262000, ootb_opportunity_amount_currency: 'USD', ootb_opportunity_current_stage: '1 - Prospecting', ootb_opportunity_is_closed: false },
    { peopleai_opportunity_id: 5537258344, name: 'Amdocs - Renewal - 42K', account_id: 23890901280, account_name: 'Ampdocs', ootb_opportunity_close_date: 'Feb 12, 2027', ootb_opportunity_amount: null, ootb_opportunity_current_stage: '1 - Onboarding', ootb_opportunity_is_closed: false },
  ],
  returned: 2,
  total_matching: 46,
}

const FIND_ACCOUNT = {
  accounts: [
    { peopleai_account_id: 23915305294, name: 'MediaTek', opportunities: [{ peopleai_opportunity_id: 5558149142, opportunity_name: 'MediaTek - New Business - 322K', owner: { id: 300124138, name: 'Juan Martinez' }, type: 'New Business' }] },
    { peopleai_account_id: 999, name: 'MediaTek Europe', opportunities: [{ peopleai_opportunity_id: 1, owner: { name: 'Someone Else' }, type: 'Renewal' }] },
  ],
}

const ENGAGED = {
  result: `<EngagementSummary timeframe_days="30">
  <ExternalGroup engaged_count="2" org="External">
    <MostEngagedParticipant email="eugene.king@mediatek.com" email_count="43" job_title="Chief Information Officer" last_engaged="2026-10-22" meeting_count="9" name="Eugene King" />
    <Participants>
      <Participant email="gerald.moore@mediatek.com" email_count="1" job_title="null" last_engaged="2026-10-02" meeting_count="0" name="Gerald Moore" />
    </Participants>
  </ExternalGroup>
  <InternalGroup engaged_count="3" org="Keyslogic">
    <MostEngagedParticipant email="juan.martinez@keys-logic.com" email_count="75" job_title="Account Executive" last_engaged="2026-10-22" meeting_count="11" name="Juan Martinez" />
    <Participants>
      <Participant email="layla.thomas@keys-logic.com" email_count="8" job_title="Sales Engineer" last_engaged="2026-10-22" meeting_count="4" name="Layla Thomas" />
      <Participant email="mohammed.ali@keys-logic.com" email_count="1" job_title="Customer Success Manager" last_engaged="2026-10-21" meeting_count="1" name="Mohammed Ali" />
    </Participants>
  </InternalGroup>
</EngagementSummary>`,
}

test('reads fetch_records rows, with its date format and a blank amount left blank', () => {
  const { deals, total } = parseOpenDeals(FETCH_RECORDS)
  assert.equal(total, 46)
  assert.deepEqual(deals[0], { id: '5568994124', name: 'Abacus - New Business - 262K', accountId: '23904725414', account: 'Abacus', close: '2027-03-02', amount: 262000, stage: '1 - Prospecting' })
  assert.equal(deals[1].amount, null, 'never estimated')
})

test('an answer that is not a record list is an error, never an empty pipeline', () => {
  assert.throws(() => parseOpenDeals({ owner_disambiguation: [] }), /did not return a record list/)
  assert.throws(() => parseOpenDeals('Service unavailable'), /did not return a record list/)
})

test('reads MCP answers in every wrapper they arrive in', () => {
  assert.equal(parseOpenDeals(JSON.stringify(FETCH_RECORDS)).deals.length, 2)
  assert.equal(parseOpenDeals({ content: [{ type: 'text', text: JSON.stringify(FETCH_RECORDS) }] }).deals.length, 2)
  assert.equal(parseOpenDeals({ structuredContent: FETCH_RECORDS }).deals.length, 2)
  assert.match(mcpText({ content: [{ type: 'text', text: JSON.stringify({ result: 'Risks: none' }) }] }), /^Risks: none$/)
})

test('takes owner and type from the account asked about, not a same-named division', () => {
  const found = parseAccountOpportunities(FIND_ACCOUNT, '23915305294')
  assert.deepEqual(found.get('5558149142'), { owner: 'Juan Martinez', type: 'New Business' })
  assert.equal(found.has('1'), false)
  assert.equal(parseAccountOpportunities(null, '1').size, 0)
})

test('reads engaged people with no email address anywhere in the result', () => {
  const { people, seller } = parseEngagedPeople(ENGAGED)
  assert.equal(seller, 'Keyslogic')
  assert.equal(people.length, 5)
  assert.deepEqual(people[0], { name: 'Eugene King', title: 'Chief Information Officer', side: 'customer', lastEngaged: '2026-10-22', emails: 43, meetings: 9 })
  assert.equal(people.find((person) => person.name === 'Gerald Moore')?.title, null, 'the literal "null" title is no title')
  assert.equal(JSON.stringify(people).includes('@'), false)
})

test('CSM and SE come from internal titles only', () => {
  const { people } = parseEngagedPeople(ENGAGED)
  assert.equal(internalWithTitle(people, CSM_TITLE), 'Mohammed Ali')
  assert.equal(internalWithTitle(people, SE_TITLE), 'Layla Thomas')
  assert.equal(internalWithTitle([{ name: 'Their CSM', title: 'Customer Success Manager', side: 'customer', lastEngaged: null, emails: 1, meetings: 1 }], CSM_TITLE), null)
})

test('maps deal types by name and says when it had to read the opportunity name', () => {
  assert.deepEqual(dealTypeOf('Customer Renewal', 'x'), { dtype: 'Renewal', inferred: false })
  assert.deepEqual(dealTypeOf('Upsell/Cross sell', 'x'), { dtype: 'Upsell', inferred: false })
  assert.deepEqual(dealTypeOf('Renewal + Upsell/Cross-sell', 'x'), { dtype: 'Renewal + Upsell', inferred: false })
  assert.deepEqual(dealTypeOf('New Business', 'x'), { dtype: 'New Business', inferred: false })
  assert.deepEqual(dealTypeOf(null, 'Gillette - Renewal - 41K'), { dtype: 'Renewal', inferred: true })
})

test('parses both date formats and rejects anything else', () => {
  assert.equal(isoDate('Feb 12, 2027'), '2027-02-12')
  assert.equal(isoDate('2026-11-06'), '2026-11-06')
  assert.equal(isoDate('soon'), null)
  assert.equal(isoDate(undefined), null)
})

test('names fiscal quarters for the year they end, matching the plugin\'s calendar', () => {
  const [current, next] = fiscalQuarters('2026-09-15', 2)
  assert.deepEqual(current, { key: 'FY27Q3', label: 'FY27 Q3', start: '2026-08-01', end: '2026-10-31', role: 'Current' })
  assert.deepEqual(next, { key: 'FY27Q4', label: 'FY27 Q4', start: '2026-11-01', end: '2027-01-31', role: 'Next' })
})

test('crosses year boundaries in both a February and a calendar fiscal year', () => {
  const [q4, q1] = fiscalQuarters('2026-11-02', 2)
  assert.equal(q4.key, 'FY27Q4')
  assert.equal(q4.end, '2027-01-31')
  assert.deepEqual([q1.key, q1.start, q1.end], ['FY28Q1', '2027-02-01', '2027-04-30'])
  const [dec, jan] = fiscalQuarters('2026-11-02', 1)
  assert.deepEqual([dec.key, dec.start, dec.end], ['FY26Q4', '2026-10-01', '2026-12-31'])
  assert.deepEqual([jan.key, jan.start, jan.end], ['FY27Q1', '2027-01-01', '2027-03-31'])
  const [janToday] = fiscalQuarters('2027-01-15', 2)
  assert.deepEqual([janToday.key, janToday.start], ['FY27Q4', '2026-11-01'])
})

test('works out the fiscal calendar from where Backstory placed the deals', () => {
  // A January close that is "this quarter" in November only fits a Nov-Jan quarter.
  assert.equal(inferFiscalStart('2026-11-02', ['2026-11-06', '2027-01-20'], ['2027-02-10', '2027-04-02']), 2)
  assert.equal(inferFiscalStart('2026-11-02', ['2026-10-20', '2026-12-05'], ['2027-01-19', '2027-03-02']), 1)
  assert.equal(inferFiscalStart('2026-11-02', ['2026-09-20', '2026-11-20'], ['2026-12-10', '2027-02-01']), 3)
})
