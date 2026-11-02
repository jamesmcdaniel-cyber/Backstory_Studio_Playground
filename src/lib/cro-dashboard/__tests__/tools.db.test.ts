/**
 * The agent's three steps against a real database: the draft chain through
 * workspace files, resuming after an outage, and the page landing as one
 * artifact whose link survives a refresh. Backstory and the model are stubbed;
 * their answers are the shapes the demo tenant returns.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
const skip = TEST_DB ? false : 'TEST_DATABASE_URL is not set — the CRO dashboard needs a real database'
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'ci-encryption-key'
  process.env.ENTITLEMENT_GATE = 'off'
}

let prisma: any
let seeded: { organizationId: string; userId: string; cleanup: () => Promise<void> }
let agentId: string
let tools: typeof import('../tools')

const NOW = new Date('2026-11-02T12:00:00Z')

const record = (id: number, account: string, accountId: number, close: string, amount: number) => ({
  peopleai_opportunity_id: id, name: `${account} - New Business`, account_id: accountId, account_name: account,
  ootb_opportunity_close_date: close, ootb_opportunity_amount: amount, ootb_opportunity_current_stage: '3 - Evaluation', ootb_opportunity_is_closed: false,
})

const THIS_QUARTER = [record(1, 'Acme', 100, 'Nov 20, 2026', 500000), record(2, 'Acme', 100, 'Jan 10, 2027', 90000), record(3, 'Globex', 200, 'Dec 05, 2026', 200000)]
const NEXT_QUARTER = [record(4, 'Initech', 300, 'Feb 12, 2027', 75000)]

const stubBackstory = (failing: { status?: boolean } = {}) => async (name: string, args: Record<string, any>): Promise<unknown> => {
  if (name === 'fetch_records') {
    const records = /this fiscal/.test(args.query) ? THIS_QUARTER : /next fiscal/.test(args.query) ? NEXT_QUARTER : [record(5, 'Hooli', 400, 'Mar 01, 2027', 10000)]
    return { records, total_matching: records.length }
  }
  if (name === 'find_account') {
    const rows = [...THIS_QUARTER, ...NEXT_QUARTER].filter((row) => row.account_name === args.account_name)
    return { accounts: [{ peopleai_account_id: rows[0]?.account_id ?? 400, opportunities: rows.map((row) => ({ peopleai_opportunity_id: row.peopleai_opportunity_id, owner: { name: 'Sam Seller' }, type: row.peopleai_opportunity_id === 2 ? 'Customer Renewal' : 'New Business' })) }] }
  }
  if (name === 'get_opportunity_status') {
    if (failing.status) throw new Error('MCP 503')
    return { result: 'Risks:\n - Legal redlines are open.\nNext steps:\n - Return redlines.' }
  }
  if (name === 'get_opportunity_engaged_people') {
    return { result: '<EngagementSummary><ExternalGroup org="External"><MostEngagedParticipant email="a@b.co" email_count="1" job_title="CIO" last_engaged="2026-10-22" meeting_count="1" name="Pat Buyer" /></ExternalGroup><InternalGroup org="Keyslogic"><MostEngagedParticipant email="c@d.co" email_count="9" job_title="Sales Engineer" last_engaged="2026-10-22" meeting_count="1" name="Lee Engineer" /></InternalGroup></EngagementSummary>' }
  }
  if (name === 'situation_search') return { situation: 'x', candidates: [] }
  throw new Error(`unexpected ${name}`)
}

/** Deal 3 is on track; everything else is at risk. */
const stubGenerate = (async (opts: { schemaName: string; user: string }) => {
  const ids = [...opts.user.matchAll(/"id":"(\d+)"/g)].map((match) => match[1])
  if (opts.schemaName === 'cro_deal_classification') {
    return JSON.stringify({ deals: ids.map((id) => id === '3'
      ? { id, status: 'on_track', outcome: 'Likely to close on time', evidence: 'Next step is dated.', onTrackNote: 'Next step is dated.' }
      : { id, status: 'not_on_track', severity: 'at_risk', reason: 'Procurement & Legal', outcome: 'At risk of slipping', evidence: 'Redlines are open.', backstoryRisks: ['Legal redlines are open.'], recordedNextStep: 'Return redlines.', blocker: 'redlines open' }) })
  }
  return JSON.stringify({ deals: ids.map((id) => ({ id, customerActions: [{ action: 'Get redlines back', owner: 'Buyer counsel', by: 'Nov 20', unblocks: 'Procurement & Legal', source: 'rubric-based', engage: [{ name: 'Pat Buyer', role: 'Exec', status: 'named', why: 'Most engaged' }] }], internalActions: [] })) })
}) as any

const client = (over: Partial<import('../tools').CroToolDeps> = {}) => new tools.CroToolClient(seeded.organizationId, seeded.userId, agentId, {
  backstory: async () => stubBackstory(),
  generate: stubGenerate,
  now: () => NOW,
  ...over,
})

before(async () => {
  if (!TEST_DB) return
  ;({ prisma } = await import('@/lib/prisma'))
  const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
  seeded = await seedTestOrg(prisma)
  tools = await import('../tools')
  const agent = await prisma.agentTask.create({ data: {
    organizationId: seeded.organizationId, userId: seeded.userId, type: 'agent', agentType: 'CUSTOM', status: 'ACTIVE', visibility: 'shared',
    description: 'CRO Dashboard', objective: 'Build it.', schedule: { type: 'manual', isActive: false }, metadata: { title: 'CRO Dashboard', integrations: ['Backstory MCP', 'CRO Dashboard'] },
  } })
  agentId = agent.id
})

after(async () => {
  if (!TEST_DB) return
  await prisma.artifactVersion.deleteMany({ where: { organizationId: seeded.organizationId } }).catch(() => undefined)
  await prisma.artifact.deleteMany({ where: { organizationId: seeded.organizationId } }).catch(() => undefined)
  await prisma.agentTask.deleteMany({ where: { id: agentId, organizationId: seeded.organizationId } }).catch(() => undefined)
  await seeded.cleanup()
  await prisma.$disconnect()
})

const dataOf = (html: string) => JSON.parse(/const DATA = (.*);\n<\/script>/.exec(html)![1])

test('builds the page from the three steps, then refreshes it in place', { skip }, async () => {
  const started: any = await client().executeTool('', 'cro_start_dashboard', {})
  assert.equal(started.error, undefined)
  assert.equal(started.deals, 4)
  assert.equal(started.totalAmount, '$865,000')
  assert.deepEqual(started.quarters.map((quarter: any) => [quarter.label, quarter.deals]), [['FY27 Q4', 3], ['FY28 Q1', 1]], 'a January close in this quarter means a February fiscal year')

  // A publish before scoring is finished is refused, not a half-empty page.
  const early: any = await client().executeTool('', 'cro_publish_dashboard', { draftId: started.draftId })
  assert.match(early.error, /not scored yet/)

  const scored: any = await client().executeTool('', 'cro_score_deals', { draftId: started.draftId })
  assert.equal(scored.done, true)
  assert.equal(scored.scoredThisCall, 4)
  assert.deepEqual([scored.onTrack.deals, scored.atRisk.deals], [1, 3])
  assert.notEqual(scored.draftId, started.draftId)
  const old: any = await client().executeTool('', 'cro_score_deals', { draftId: started.draftId })
  assert.match(old.error, /not found/, 'each round replaces the last draft file')

  const published: any = await client().executeTool('', 'cro_publish_dashboard', { draftId: scored.draftId })
  assert.equal(published.error, undefined)
  assert.equal(published.newArtifact, true)
  assert.equal(published.onTrack.amount, '$200,000')
  assert.ok(published.limits.some((limit: string) => /Black-health/.test(limit)), 'the run reports what it could not do')

  const artifact = await prisma.artifact.findFirst({ where: { organizationId: seeded.organizationId, agentTaskId: agentId } })
  assert.equal(artifact.kind, 'page')
  assert.equal(artifact.title, 'CRO Pipeline Health')
  assert.equal(published.link, `/artifacts/${artifact.id}`)
  const version = await prisma.artifactVersion.findFirst({ where: { id: artifact.currentVersionId, organizationId: seeded.organizationId } })
  const data = dataOf(version.content)
  assert.equal(data.seller, 'Keyslogic')
  assert.equal(data.fiscalYearStartMonth, 2)
  const acme = data.deals.find((deal: any) => deal.id === '2')
  assert.equal(acme.dtype, 'Renewal')
  assert.equal(acme.owner, 'Sam Seller')
  assert.equal(acme.amt, 90000, 'amounts come from Backstory, never the model')
  assert.equal(acme.se, 'Lee Engineer')
  for (const bookkeeping of ['accountId', 'pending', 'attempts', 'typeInferred']) assert.equal(bookkeeping in acme, false, bookkeeping)
  assert.equal(JSON.stringify(data).includes('a@b.co'), false, 'no email on the page')
  assert.equal(await prisma.storedFile.count({ where: { organizationId: seeded.organizationId, filename: { startsWith: 'cro-dashboard-draft-' } } }), 0, 'no draft left behind')

  // A second build is a new version of the same page: the link stays.
  const again: any = await client().executeTool('', 'cro_start_dashboard', { extraQuarters: [{ start: '2027-02-01', end: '2027-04-30' }] })
  const rescored: any = await client().executeTool('', 'cro_score_deals', { draftId: again.draftId })
  const republished: any = await client().executeTool('', 'cro_publish_dashboard', { draftId: rescored.draftId })
  assert.equal(republished.link, published.link)
  assert.equal(republished.newArtifact, false)
  assert.equal(republished.version, 2)
  assert.equal(await prisma.artifact.count({ where: { organizationId: seeded.organizationId, agentTaskId: agentId } }), 1)
})

test('an outage stops scoring with the draft intact, and the same call resumes it', { skip }, async () => {
  const started: any = await client().executeTool('', 'cro_start_dashboard', {})
  const down: any = await client({ backstory: async () => stubBackstory({ status: true }) }).executeTool('', 'cro_score_deals', { draftId: started.draftId })
  assert.match(down.error, /MCP 503/)
  assert.equal(down.remaining, 4, 'an outage gives up on no deal')
  const resumed: any = await client().executeTool('', 'cro_score_deals', { draftId: down.draftId })
  assert.equal(resumed.done, true)
  assert.equal(resumed.scoredThisCall, 4)
})

test('one deal that keeps failing is shown as not scored, not dropped or called healthy', { skip }, async () => {
  const started: any = await client().executeTool('', 'cro_start_dashboard', {})
  const flaky = async (name: string, args: Record<string, any>) => {
    if (name === 'get_opportunity_status' && args.peopleai_opportunity_id === 4) throw new Error('no record')
    return stubBackstory()(name, args)
  }
  const result: any = await client({ backstory: async () => flaky }).executeTool('', 'cro_score_deals', { draftId: started.draftId })
  assert.equal(result.done, true)
  assert.equal(result.notAnalyzed.deals, 1)
  const published: any = await client().executeTool('', 'cro_publish_dashboard', { draftId: result.draftId })
  assert.ok(published.limits.some((limit: string) => /1 deal could not be scored/.test(limit)))
  const artifact = await prisma.artifact.findFirst({ where: { organizationId: seeded.organizationId, agentTaskId: agentId } })
  const version = await prisma.artifactVersion.findFirst({ where: { id: artifact.currentVersionId, organizationId: seeded.organizationId } })
  const data = dataOf(version.content)
  assert.equal(data.deals.find((deal: any) => deal.id === '4').status, 'unanalyzed')
  assert.ok(data.notes.some((note: string) => /Not scored/.test(note)))
})

test('a draft id cannot read another file', { skip }, async () => {
  const { saveStoredFile } = await import('@/lib/files/storage')
  const other = await saveStoredFile({ organizationId: seeded.organizationId, userId: seeded.userId, filename: 'someone-elses.json', mimeType: 'application/json', buffer: Buffer.from('{"kind":"cro-dashboard-draft","deals":[]}'), trusted: true })
  const refused: any = await client().executeTool('', 'cro_publish_dashboard', { draftId: other.id })
  assert.match(refused.error, /not found/)
})

test('the plane loads for an agent that selects it, and never in the flow catalogue', { skip }, async () => {
  const { loadNativePlaneGroups } = await import('@/features/agents/tool-planes')
  const selected = await loadNativePlaneGroups(seeded.organizationId, { providers: ['CRO Dashboard'], httpUserId: seeded.userId, agentId })
  assert.deepEqual(selected.find((group) => group.provider === 'cro_dashboard')?.tools.map((tool) => tool.name), ['cro_start_dashboard', 'cro_score_deals', 'cro_publish_dashboard'])
  const unselected = await loadNativePlaneGroups(seeded.organizationId, { providers: ['Slack'], httpUserId: seeded.userId, agentId })
  assert.equal(unselected.some((group) => group.provider === 'cro_dashboard'), false)
  const catalogue = await loadNativePlaneGroups(seeded.organizationId, {})
  assert.equal(catalogue.some((group) => group.provider === 'cro_dashboard'), false)
})
