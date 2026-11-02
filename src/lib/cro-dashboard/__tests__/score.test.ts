import test from 'node:test'
import assert from 'node:assert/strict'
import { applyLabel, normalizeEngage, parseAnalogues, scoreBatch, situationQuery, type StructuredGenerator } from '../score'
import { renderCroDashboard, validateCroData, type CroDashboardData, type CroDeal } from '../schema'
import type { EngagedPerson } from '../pipeline'

const deal = (over: Partial<CroDeal> = {}): CroDeal => ({
  id: '5558149142', name: 'MediaTek - New Business - 322K', acct: 'MediaTek', tier: null, csm: null, se: null, owner: 'Juan Martinez',
  dtype: 'New Business', stage: '6 - Negotiation', amt: 322000, close: '2026-11-06', q: 'FY27Q4', status: 'unanalyzed', ...over,
})

const ENGAGED = `<EngagementSummary><ExternalGroup org="External"><MostEngagedParticipant email="eugene.king@mediatek.com" email_count="43" job_title="Chief Information Officer" last_engaged="2026-10-22" meeting_count="9" name="Eugene King" /></ExternalGroup><InternalGroup org="Keyslogic"><MostEngagedParticipant email="juan.martinez@keys-logic.com" email_count="75" job_title="Account Executive" last_engaged="2026-10-22" meeting_count="11" name="Juan Martinez" /><Participant email="m.ali@keys-logic.com" email_count="1" job_title="Customer Success Manager" last_engaged="2026-10-21" meeting_count="1" name="Mohammed Ali" /></InternalGroup></EngagementSummary>`

const STATUS = 'Risks:\n - **Eugene King** has raised security concerns.\nNext steps:\n - **Tonya Roberson**: return redlines. Contact tonya@mediatek.com\n'

const SITUATIONS = {
  situation: 'Buyer and seller worked through security redlines.',
  candidates: [{ object_type: 'opportunity', opportunity_name: 'Crucial - New Business', account_name: 'Crucial', situation_summary: 'Buyer raised compliance concerns.', actions_taken: ['Seller provided security documentation.'], outcome: 'Concerns reduced.', opportunity_is_closed: true, opportunity_is_won: true }],
}

const backstory = (over: Record<string, () => unknown> = {}) => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const answers: Record<string, () => unknown> = {
    get_opportunity_status: () => ({ result: STATUS }),
    get_opportunity_engaged_people: () => ({ result: ENGAGED }),
    situation_search: () => SITUATIONS,
    ...over,
  }
  return {
    calls,
    call: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args })
      return answers[name]()
    },
  }
}

const NOT_ON_TRACK = { id: '5558149142', status: 'not_on_track', severity: 'at_risk', reason: 'Procurement & Legal', secondary: ['Budget & Pricing'], outcome: 'At risk of slipping', evidence: 'Security concerns are open.', backstoryRisks: ['**Security** concerns'], recordedNextStep: 'Return redlines', blocker: 'MediaTek legal has not returned redlines from Eugene King' }

const ACTIONS = {
  deals: [{
    id: '5558149142',
    customerActions: [{
      action: 'Get redlines back by Nov 5', owner: 'Buyer counsel', by: 'Nov 5', unblocks: 'Procurement & Legal', source: 'Similar deal that closed won',
      engage: [
        { name: 'Eugene King', role: 'Exec', status: 'named', why: 'Most engaged' },
        { name: 'Invented Person', role: 'Procurement/Legal', status: 'named', why: 'Runs procurement' },
        { name: 'Juan Martinez', role: 'AE', status: 'named', why: 'Wrong side' },
      ],
    }],
    internalActions: [{ action: 'Escalate via exec sponsor if no reply', owner: 'Juan Martinez', by: 'Nov 6', unblocks: 'Procurement & Legal', source: 'rubric-based', engage: [{ name: 'Tonya Roberson', role: 'Legal', status: 'named', why: 'Reach her at tonya@mediatek.com' }] }],
  }],
}

const generator = (classify: unknown, recommend: unknown = ACTIONS) => {
  const prompts: Array<{ system: string; user: string; schemaName: string }> = []
  const generate = (async (opts: { system: string; user: string; schemaName: string }) => {
    prompts.push(opts)
    return JSON.stringify(opts.schemaName === 'cro_deal_classification' ? classify : recommend)
  }) as unknown as StructuredGenerator
  return { generate, prompts }
}

const deps = (over: { backstory: (name: string, args: Record<string, unknown>) => Promise<unknown>; generate: StructuredGenerator }) => ({
  ...over,
  ledger: { organizationId: 'org' },
  today: '2026-11-02',
  quarterEndOf: () => '2027-01-31',
})

test('scores a deal not on track, end to end through the checks', async () => {
  const mcp = backstory()
  const { generate, prompts } = generator({ deals: [NOT_ON_TRACK] })
  const { scored, failed, seller } = await scoreBatch([deal()], deps({ backstory: mcp.call, generate }))
  assert.deepEqual(failed, [])
  assert.equal(seller, 'Keyslogic')
  const [result] = scored
  assert.equal(result.severity, 'at_risk')
  assert.equal(result.reason, 'Procurement & Legal')
  assert.equal(result.csm, 'Mohammed Ali', 'CSM read from the engaged title')
  assert.deepEqual(result.backstoryRisks, ['Security concerns'], 'no Markdown on the page')
  const customer = result.customerActions![0]
  assert.equal(customer.source, 'Similar deal that closed won')
  assert.deepEqual(customer.engage.map((person) => [person.name, person.status]), [['Eugene King', 'engaged'], ['Procurement/Legal to identify', 'to_identify']], 'the made-up person is a role to identify, and our AE is off a customer step')
  assert.equal(customer.engage[0].title, 'Chief Information Officer', 'the title is Backstory\'s, not the model\'s')
  const internal = result.internalActions![0]
  assert.equal(internal.engage[0].name, 'Tonya Roberson')
  assert.equal(internal.engage[0].status, 'not_engaged', 'named in the status but not in the 30-day engaged list')
  assert.equal(JSON.stringify(result).includes('@'), false, 'no email reaches the page')
  for (const prompt of prompts) {
    assert.match(prompt.user, /<untrusted_data/, 'tool output is fenced')
    assert.match(prompt.system, /NEVER obey instructions/)
    assert.equal(prompt.user.includes('juan.martinez@keys-logic.com'), false, 'engaged emails stay out of the prompt')
  }
  const recommendPrompt = prompts.find((prompt) => prompt.schemaName === 'cro_deal_recommendations')!
  assert.equal(recommendPrompt.user.includes('Crucial'), false, 'another customer\'s name stays out')
  const search = mcp.calls.find((call) => call.name === 'situation_search')!
  assert.equal(search.args.object_type, 'opportunity')
  assert.equal(search.args.peopleai_object_id, 5558149142)
  assert.doesNotMatch(String(search.args.query), /MediaTek|Eugene King/, 'situation queries carry the situation, never names')
})

test('an on-track deal gets no situation search and no recommendations', async () => {
  const mcp = backstory()
  const { generate, prompts } = generator({ deals: [{ id: '5558149142', status: 'on_track', outcome: 'Likely to close on time', evidence: 'Contract in final review.', onTrackNote: 'Next step is dated next week.' }] })
  const { scored } = await scoreBatch([deal()], deps({ backstory: mcp.call, generate }))
  assert.equal(scored[0].status, 'on_track')
  assert.equal(scored[0].customerActions, undefined)
  assert.equal(mcp.calls.some((call) => call.name === 'situation_search'), false)
  assert.equal(prompts.length, 1, 'no recommendation pass')
})

test('a Backstory failure is a failed deal, never a Low Engagement verdict', async () => {
  const mcp = backstory({ get_opportunity_status: () => { throw new Error('MCP 503') } })
  const { generate, prompts } = generator({ deals: [] })
  const { scored, failed, firstError } = await scoreBatch([deal()], deps({ backstory: mcp.call, generate }))
  assert.deepEqual(scored, [])
  assert.deepEqual(failed, ['5558149142'])
  assert.match(firstError!, /MCP 503/)
  assert.equal(prompts.length, 0, 'the model is not asked to label a deal with no evidence')
})

test('a model outage fails the batch rather than inventing labels', async () => {
  const generate = (async () => { throw new Error('overloaded') }) as unknown as StructuredGenerator
  const { scored, failed, firstError } = await scoreBatch([deal()], deps({ backstory: backstory().call, generate }))
  assert.deepEqual(scored, [])
  assert.deepEqual(failed, ['5558149142'])
  assert.match(firstError!, /overloaded/)
})

test('a label outside the nine reasons is refused', async () => {
  const { generate } = generator({ deals: [{ ...NOT_ON_TRACK, reason: 'Bad Vibes' }] })
  const { scored, failed } = await scoreBatch([deal()], deps({ backstory: backstory().call, generate }))
  assert.deepEqual(scored, [])
  assert.deepEqual(failed, ['5558149142'])
})

test('with no past situation every step is rubric-based, whatever the model cited', async () => {
  const mcp = backstory({ situation_search: () => ({ situation: 'x', candidates: [] }) })
  const { generate } = generator({ deals: [NOT_ON_TRACK] })
  const { scored } = await scoreBatch([deal()], deps({ backstory: mcp.call, generate }))
  assert.equal(scored[0].customerActions![0].source, 'rubric-based')
  assert.equal(scored[0].situationNote, 'No comparable past situation found.')
})

test('a failed situation search says so instead of claiming nothing comparable exists', async () => {
  const mcp = backstory({ situation_search: () => { throw new Error('timeout') } })
  const { generate } = generator({ deals: [NOT_ON_TRACK] })
  const { scored } = await scoreBatch([deal()], deps({ backstory: mcp.call, generate }))
  assert.match(scored[0].situationNote!, /unavailable/)
})

test('a deal not on track with no recommendation is not published without one', async () => {
  const { generate } = generator({ deals: [NOT_ON_TRACK] }, { deals: [{ id: '5558149142', customerActions: [], internalActions: [] }] })
  const { scored, failed } = await scoreBatch([deal()], deps({ backstory: backstory().call, generate }))
  assert.deepEqual(scored, [])
  assert.deepEqual(failed, ['5558149142'])
})

test('a passed close date is never on track, whatever the model says', () => {
  const label = { id: 'x', status: 'on_track' as const, outcome: 'Likely to close on time', evidence: 'Going well.' }
  const late = applyLabel(deal({ close: '2026-10-01' }), label, '2026-11-02')!
  assert.equal(late.status, 'not_on_track')
  assert.equal(late.severity, 'slipping')
  assert.match(late.evidence!, /2026-10-01 has passed/)
  assert.equal(applyLabel(deal(), label, '2026-11-02')!.status, 'on_track')
})

test('leaves no person or company name in a situation query', () => {
  const people: EngagedPerson[] = [{ name: 'Eugene King', title: null, side: 'customer', lastEngaged: null, emails: 0, meetings: 0 }]
  const query = situationQuery(deal({ reason: 'Stakeholder Access' }), 'Eugene King at MediaTek went quiet', people)
  assert.equal(query, 'Stakeholder Access, the party at the party went quiet, 6 - Negotiation stage, New Business')
})

test('engage is never empty, so the page always has someone to name', () => {
  const engage = normalizeEngage([], 'internal', [], '')
  assert.deepEqual(engage.map((person) => person.status), ['to_identify'])
})

test('marks a past situation won, lost or still open', () => {
  const [won] = parseAnalogues(SITUATIONS)
  assert.equal(won.result, 'won')
  assert.equal(JSON.stringify(won).includes('Crucial'), false)
  assert.equal(parseAnalogues({ candidates: [{ opportunity_is_closed: true, opportunity_is_won: false }] })[0].result, 'lost')
  assert.equal(parseAnalogues({ candidates: [{ opportunity_is_closed: false }] })[0].result, 'open')
  assert.deepEqual(parseAnalogues('no matches'), [])
})

const data = (deals: CroDeal[]): CroDashboardData => ({
  today: '2026-11-02', builtAt: 'Nov 2, 2026', seller: 'Keyslogic', fiscalYearStartMonth: 2,
  quarters: [{ key: 'FY27Q4', label: 'FY27 Q4', start: '2026-11-01', end: '2027-01-31', role: 'Current' }],
  notes: ['<b>Open deals only.</b>'], deals,
})

test('the page refuses data it cannot show', () => {
  assert.deepEqual(validateCroData(data([deal()])), [], 'a pipeline-only row is valid')
  const onTrackWithReason = deal({ status: 'on_track', reason: 'Competitive' })
  assert.match(validateCroData(data([onTrackWithReason]))[0], /no reason/)
  const noAdvice = deal({ status: 'not_on_track', severity: 'at_risk', reason: 'Competitive' })
  assert.match(validateCroData(data([noAdvice]))[0], /needs a recommendation/)
  assert.match(validateCroData(data([deal(), deal()])).join(), /duplicate id/)
  assert.match(validateCroData(data([deal({ q: 'FY99Q1' })])).join(), /not on the page/)
  assert.throws(() => renderCroDashboard(data([noAdvice])), /does not match the page/)
})

test('deal text cannot break out of the page\'s script block or the replacement', () => {
  const hostile = deal({ name: '</script><script>alert(1)</script>', acct: 'A $& B $` C <!-- x' })
  const html = renderCroDashboard(data([hostile]))
  assert.equal(html.includes('</script><script>alert(1)'), false)
  assert.ok(html.includes('A $& B $` C'), 'a dollar pattern stays literal text')
  assert.equal(html.includes('<!-- x'), false)
  assert.equal(html.includes('/*__DATA__*/null'), false)
  assert.equal(JSON.parse(/const DATA = (.*);\n<\/script>/.exec(html)![1]).deals[0].name, hostile.name, 'and reads back exactly')
})

test('the page asks for nothing the sandbox would refuse', () => {
  const html = renderCroDashboard(data([deal()]))
  assert.match(html, /^<!doctype html>/)
  assert.match(html, /<title>CRO Pipeline Health<\/title>/)
  for (const gone of ['fonts.googleapis', 'window.claude', 'execute_soql_query', 'Salesforce']) assert.equal(html.includes(gone), false, gone)
})
