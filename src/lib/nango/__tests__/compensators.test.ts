import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NANGO_COMPENSATIONS, compensationFor, slackBotProxy, type Compensation } from '../compensators'
import { NANGO_PROVIDER_TOOLS } from '../provider-tools'
import { DELIVERY_TOOLS, type NangoProxyArgs } from '../delivery'

const connection = { connectionId: 'conn-1', providerConfigKey: 'cfg', scope: 'user' as const }

/** A scripted Nango proxy that records every request. */
function fakeProxy(responses: unknown[] = []) {
  const calls: NangoProxyArgs[] = []
  const proxy = async (request: NangoProxyArgs) => {
    calls.push(request)
    return { data: responses.length ? responses.shift() : { ok: true } }
  }
  return { calls, proxy }
}

const undoable = (name: string) => {
  const entry = NANGO_COMPENSATIONS[name]
  assert.ok(entry?.undoable, `${name} should be undoable`)
  return entry as Extract<Compensation, { undoable: true }>
}

test('every Nango write tool has a compensation decision — undoable or a stated reason', () => {
  const writes = [...NANGO_PROVIDER_TOOLS.filter((tool) => tool.isWrite).map((tool) => tool.name), ...DELIVERY_TOOLS.map((tool) => tool.name)]
  for (const name of writes) {
    const entry = NANGO_COMPENSATIONS[name]
    assert.ok(entry, `${name} is a write tool with no entry in the compensator registry`)
    if (!entry.undoable) assert.ok(entry.reason.length > 10, `${name} must say why it can't be undone`)
  }
  // …and the registry names no read tools (an undo entry on a read is a mistake).
  const reads = new Set(NANGO_PROVIDER_TOOLS.filter((tool) => !tool.isWrite).map((tool) => tool.name))
  for (const name of Object.keys(NANGO_COMPENSATIONS)) assert.equal(reads.has(name), false, `${name} is a read tool`)
})

test('a Slack post is undone by deleting it with the channel id and ts Slack returned', async () => {
  const slack = undoable('slack_post_message')
  const ref = slack.ref({ ok: true, channel: 'C123', ts: '1700.0001' }, { channel: '#revenue', text: 'hi' })
  assert.deepEqual(ref, { channel: 'C123', ts: '1700.0001', label: '#revenue' })
  const { calls, proxy } = fakeProxy([{ ok: true }])
  await slack.undo(connection, { args: {}, ref: ref!, before: null }, proxy)
  assert.deepEqual(calls, [{ method: 'POST', endpoint: '/chat.delete', data: { channel: 'C123', ts: '1700.0001' }, connectionId: 'conn-1', providerConfigKey: 'cfg' }])
})

test("Slack's ok:false on delete surfaces as an error (e.g. message_not_found), not a silent success", async () => {
  const slack = undoable('slack_post_message')
  const { proxy } = fakeProxy([{ ok: false, error: 'message_not_found' }])
  await assert.rejects(slack.undo(connection, { args: {}, ref: { channel: 'C1', ts: '1' }, before: null }, proxy), /message_not_found/)
})

test('a created Salesforce record is deleted by the id Salesforce returned; without one there is nothing to undo', async () => {
  const sf = undoable('salesforce_create_record')
  const ref = sf.ref({ id: '00T5e000001', success: true }, { sobject: 'Task', fields: {} })!
  const { calls, proxy } = fakeProxy()
  await sf.undo(connection, { args: {}, ref, before: null }, proxy)
  assert.equal(calls[0].method, 'DELETE')
  assert.equal(calls[0].endpoint, '/services/data/v60.0/sobjects/Task/00T5e000001')
  assert.match(sf.missing!({ args: {}, ref: { sobject: 'Task' }, before: null }) ?? '', /didn't return an id/)
})

test('a Salesforce update captures only the touched fields before writing, and undo puts them back', async () => {
  const sf = undoable('salesforce_update_record')
  const { calls, proxy } = fakeProxy([{ attributes: {}, StageName: 'Prospecting', Amount: null, Name: 'Untouched' }, {}])
  const before = await sf.captureBefore!(connection, { sobject: 'Opportunity', id: '006X', fields: { StageName: 'Closed Won', Amount: 5000 } }, proxy)
  assert.deepEqual(calls[0].params, { fields: 'StageName,Amount' })
  assert.deepEqual(before, { StageName: 'Prospecting', Amount: null })
  const ref = sf.ref({}, { sobject: 'Opportunity', id: '006X' })!
  await sf.undo(connection, { args: {}, ref, before }, proxy)
  assert.deepEqual({ method: calls[1].method, endpoint: calls[1].endpoint, data: calls[1].data }, { method: 'PATCH', endpoint: '/services/data/v60.0/sobjects/Opportunity/006X', data: { StageName: 'Prospecting', Amount: null } })
  assert.match(sf.missing!({ args: {}, ref, before: null }) ?? '', /earlier values/)
})

test('a Sheets range update restores the earlier cells, padded so blank cells are blanked again', async () => {
  const sheets = undoable('google_sheets_update_range')
  const { calls, proxy } = fakeProxy([{ range: 'Sheet1!A1:C2', values: [['a']] }, {}])
  const before = await sheets.captureBefore!(connection, { spreadsheetId: 'S', range: 'Sheet1!A1:C2', values: [['x', 'y', 'z'], ['p', 'q']] }, proxy)
  assert.deepEqual(before, { range: 'Sheet1!A1:C2', values: [['a', '', ''], ['', '']] })
  await sheets.undo(connection, { args: {}, ref: { id: 'S' }, before }, proxy)
  assert.equal(calls[1].method, 'PUT')
  assert.deepEqual(calls[1].data, { values: [['a', '', ''], ['', '']] })
})

test('calendar events, GitHub issues and Notion appends each undo through their own reverse call', async () => {
  const { calls, proxy } = fakeProxy()
  const cal = undoable('google_calendar_create_event')
  await cal.undo(connection, { args: {}, ref: cal.ref({ id: 'ev1', htmlLink: 'https://cal/ev1' }, { calendarId: 'team@x.com', summary: 'Sync' })!, before: null }, proxy)
  assert.deepEqual([calls[0].method, calls[0].endpoint], ['DELETE', '/calendar/v3/calendars/team%40x.com/events/ev1'])

  const gh = undoable('github_create_issue')
  assert.match(gh.effect, /doesn't let apps delete/)
  await gh.undo(connection, { args: {}, ref: gh.ref({ number: 42, html_url: 'https://gh/42' }, { owner: 'o', repo: 'r' })!, before: null }, proxy)
  assert.deepEqual([calls[1].method, calls[1].endpoint, calls[1].data], ['PATCH', '/repos/o/r/issues/42', { state: 'closed', state_reason: 'not_planned' }])

  const notion = undoable('notion_update_page')
  const ref = notion.ref({ results: [{ id: 'b1' }, { id: 'b2' }] }, { pageId: 'p' })!
  await notion.undo(connection, { args: {}, ref, before: null }, proxy)
  assert.deepEqual(calls.slice(2).map((call) => call.endpoint), ['/v1/blocks/b1', '/v1/blocks/b2'])
})

test('email cannot be unsent, and says so; the ref still records the message id', () => {
  const gmail = NANGO_COMPENSATIONS.gmail_send_email
  assert.equal(gmail.undoable, false)
  assert.match(gmail.undoable ? '' : gmail.reason, /can't be recalled/)
  assert.deepEqual(gmail.ref?.({ id: 'm1', threadId: 't1' }, {}), { id: 'm1', threadId: 't1' })
})

test('compensationFor covers every plane with an answer', () => {
  assert.equal(compensationFor({ plane: 'native', provider: 'slack', tool: 'post_message' }).undoable, true, 'the workspace bot can delete its own post')
  const warehouse = compensationFor({ plane: 'native', provider: 'snowflake', tool: 'snowflake_sql_query' })
  assert.match(warehouse.undoable ? '' : warehouse.reason, /Time Travel/)
  const job = compensationFor({ plane: 'native', provider: 'databricks', tool: 'databricks_run_job' })
  assert.match(job.undoable ? '' : job.reason, /un-run/)
  const mcp = compensationFor({ plane: 'mcp', provider: 'acme', tool: 'update' })
  assert.match(mcp.undoable ? '' : mcp.reason, /doesn't describe how to reverse/)
  assert.equal(compensationFor({ plane: 'native', provider: 'email', tool: 'send_email' }).undoable, false)
  assert.equal(compensationFor({ plane: 'nango', provider: 'nango:github', tool: 'not_a_tool' }).undoable, false)
})

test('the bot transport sends the call to the Slack Web API with the workspace token', async () => {
  const seen: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init })
    return new Response(JSON.stringify({ ok: true }))
  }) as unknown as typeof fetch
  const result = await slackBotProxy('xoxb-test', fetchImpl)({ method: 'POST', endpoint: '/chat.delete', connectionId: 'x', providerConfigKey: 'slack', data: { channel: 'C', ts: '1' } })
  assert.deepEqual(result, { data: { ok: true } })
  assert.equal(seen[0].url, 'https://slack.com/api/chat.delete')
  assert.equal((seen[0].init.headers as Record<string, string>).Authorization, 'Bearer xoxb-test')
})
