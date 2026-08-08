import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DeliveryConnection, NangoProxyArgs } from '../delivery'
import { NANGO_PROVIDER_TOOLS, PROVIDER_CONFIG_KEYS, toolsForProvider } from '../provider-tools'

const conn: DeliveryConnection = { connectionId: 'c1', providerConfigKey: 'github', scope: 'user' }

/** Capture the proxy request an adapter emits (no network). */
function spyProxy() {
  const calls: NangoProxyArgs[] = []
  const proxy = async (args: NangoProxyArgs) => {
    calls.push(args)
    return { data: { ok: true } }
  }
  return { proxy, calls }
}

const run = (name: string, args: Record<string, unknown>) => {
  const spec = NANGO_PROVIDER_TOOLS.find((t) => t.name === name)
  assert.ok(spec, `spec ${name} exists`)
  const { proxy, calls } = spyProxy()
  return spec!.run(conn, args, proxy).then(() => calls[0])
}

test('every provider tool has a config-key mapping and a well-formed schema', () => {
  for (const tool of NANGO_PROVIDER_TOOLS) {
    assert.ok(PROVIDER_CONFIG_KEYS[tool.provider]?.length, `${tool.provider} has config keys`)
    assert.equal(typeof tool.isWrite, 'boolean')
    assert.ok(tool.name.startsWith(`${tool.provider}_`), `${tool.name} is provider-namespaced`)
    assert.equal((tool.inputSchema as { type?: string }).type, 'object')
  }
})

test('github: read tools are not writes; create/comment are writes', () => {
  assert.equal(NANGO_PROVIDER_TOOLS.find((t) => t.name === 'github_list_repositories')!.isWrite, false)
  assert.equal(NANGO_PROVIDER_TOOLS.find((t) => t.name === 'github_list_pull_requests')!.isWrite, false)
  assert.equal(NANGO_PROVIDER_TOOLS.find((t) => t.name === 'github_create_issue')!.isWrite, true)
  assert.equal(NANGO_PROVIDER_TOOLS.find((t) => t.name === 'github_comment')!.isWrite, true)
})

test('github_list_repositories → GET /user/repos, or /users/{owner}/repos with owner', async () => {
  const mine = await run('github_list_repositories', {})
  assert.equal(mine.method, 'GET')
  assert.equal(mine.endpoint, '/user/repos')
  assert.equal(mine.connectionId, 'c1')
  assert.equal((mine.params as { per_page: number }).per_page, 30)

  const org = await run('github_list_repositories', { owner: 'acme', per_page: 5 })
  assert.equal(org.endpoint, '/users/acme/repos')
  assert.equal((org.params as { per_page: number }).per_page, 5)
})

test('github_list_pull_requests → GET /repos/{o}/{r}/pulls with state', async () => {
  const c = await run('github_list_pull_requests', { owner: 'acme', repo: 'app', state: 'closed' })
  assert.equal(c.method, 'GET')
  assert.equal(c.endpoint, '/repos/acme/app/pulls')
  assert.equal((c.params as { state: string }).state, 'closed')
})

test('github_create_issue → POST /repos/{o}/{r}/issues with title+body', async () => {
  const c = await run('github_create_issue', { owner: 'acme', repo: 'app', title: 'Bug', body: 'Steps' })
  assert.equal(c.method, 'POST')
  assert.equal(c.endpoint, '/repos/acme/app/issues')
  assert.deepEqual(c.data, { title: 'Bug', body: 'Steps' })
  // body omitted when absent
  const noBody = await run('github_create_issue', { owner: 'acme', repo: 'app', title: 'T' })
  assert.deepEqual(noBody.data, { title: 'T' })
})

test('github_comment → POST issue comments endpoint', async () => {
  const c = await run('github_comment', { owner: 'acme', repo: 'app', issue_number: 42, body: 'thanks' })
  assert.equal(c.endpoint, '/repos/acme/app/issues/42/comments')
  assert.deepEqual(c.data, { body: 'thanks' })
})

test('linear_list_issues → POST /graphql with a query variable', async () => {
  const c = await run('linear_list_issues', { query: 'login bug', first: 10 })
  assert.equal(c.method, 'POST')
  assert.equal(c.endpoint, '/graphql')
  const data = c.data as { query: string; variables: { first: number; filter?: unknown } }
  assert.ok(data.query.includes('issues('))
  assert.equal(data.variables.first, 10)
  assert.ok(data.variables.filter, 'a text query becomes a filter')
  // no query → no filter
  const all = await run('linear_list_issues', {})
  assert.equal((all.data as { variables: { filter?: unknown } }).variables.filter, undefined)
})

test('linear_create_issue → issueCreate mutation with team+title, optional fields omitted', async () => {
  const c = await run('linear_create_issue', { teamId: 'T1', title: 'New' })
  const data = c.data as { query: string; variables: { input: Record<string, unknown> } }
  assert.ok(data.query.includes('issueCreate'))
  assert.deepEqual(data.variables.input, { teamId: 'T1', title: 'New' })
  const full = await run('linear_create_issue', { teamId: 'T1', title: 'N', description: 'D', assigneeId: 'U9' })
  assert.deepEqual((full.data as { variables: { input: Record<string, unknown> } }).variables.input, {
    teamId: 'T1', title: 'N', description: 'D', assigneeId: 'U9',
  })
})

test('linear_update_issue → issueUpdate mutation with only the changed fields', async () => {
  const c = await run('linear_update_issue', { id: 'I1', stateId: 'S2' })
  const data = c.data as { query: string; variables: { id: string; input: Record<string, unknown> } }
  assert.ok(data.query.includes('issueUpdate'))
  assert.equal(data.variables.id, 'I1')
  assert.deepEqual(data.variables.input, { stateId: 'S2' })
})

test('toolsForProvider groups by provider', () => {
  assert.equal(toolsForProvider('github').length, 4)
  assert.equal(toolsForProvider('linear').length, 3)
  assert.equal(toolsForProvider('nonexistent').length, 0)
})

test('all authored providers have tools and unique tool names', () => {
  const providers = new Set(NANGO_PROVIDER_TOOLS.map((t) => t.provider))
  for (const p of ['github', 'linear', 'jira', 'asana', 'notion', 'hubspot', 'confluence', 'google_drive', 'google_sheets', 'monday', 'zendesk', 'slack', 'salesforce', 'gmail', 'granola']) {
    assert.ok(providers.has(p), `provider ${p} has tools`)
  }
  const names = NANGO_PROVIDER_TOOLS.map((t) => t.name)
  assert.equal(names.length, new Set(names).size, 'tool names are unique')
})

test('jira_list_issues builds JQL from a project and uses the /search/jql endpoint', async () => {
  const byJql = await run('jira_list_issues', { jql: 'assignee = currentUser()' })
  assert.equal(byJql.endpoint, '/rest/api/3/search/jql')
  assert.equal((byJql.params as { jql: string }).jql, 'assignee = currentUser()')
  assert.ok((byJql.params as { fields: string }).fields.includes('summary'))
  const byProject = await run('jira_list_issues', { project: 'ENG' })
  assert.ok((byProject.params as { jql: string }).jql.includes('project = ENG'))
})

test('jira_create_issue wraps description in Atlassian Document Format', async () => {
  const c = await run('jira_create_issue', { project: 'ENG', summary: 'Bug', description: 'Steps to repro' })
  const desc = (c.data as { fields: { description: { type: string; content: unknown[] } } }).fields.description
  assert.equal(desc.type, 'doc')
  assert.ok(Array.isArray(desc.content))
})

test('notion tools send the Notion-Version header', async () => {
  const c = await run('notion_search', { query: 'launch' })
  assert.equal((c.headers as Record<string, string>)['Notion-Version'], '2022-06-28')
  assert.equal(c.endpoint, '/v1/search')
})

test('google_sheets_append_row wraps a single row and sets valueInputOption', async () => {
  const c = await run('google_sheets_append_row', { spreadsheetId: 'S1', range: 'Sheet1!A1', values: ['a', 'b'] })
  assert.equal(c.method, 'POST')
  assert.ok(c.endpoint.endsWith(':append'))
  assert.equal((c.params as { valueInputOption: string }).valueInputOption, 'USER_ENTERED')
  assert.deepEqual((c.data as { values: unknown[][] }).values, [['a', 'b']])
})

test('slack_search_messages → GET /search.messages with query and count', async () => {
  const c = await run('slack_search_messages', { query: 'deploy in:#eng', count: 5 })
  assert.equal(c.method, 'GET')
  assert.equal(c.endpoint, '/search.messages')
  assert.deepEqual(c.params, { query: 'deploy in:#eng', count: 5 })
})

test('slack_add_reaction → POST /reactions.add, emoji colons stripped', async () => {
  const c = await run('slack_add_reaction', { channel: 'C1', timestamp: '123.456', name: ':thumbsup:' })
  assert.equal(c.method, 'POST')
  assert.equal(c.endpoint, '/reactions.add')
  assert.deepEqual(c.data, { channel: 'C1', timestamp: '123.456', name: 'thumbsup' })
})

test('slack_send_direct_message opens the IM conversation, then posts into it', async () => {
  const spec = NANGO_PROVIDER_TOOLS.find((t) => t.name === 'slack_send_direct_message')!
  const calls: NangoProxyArgs[] = []
  const proxy = async (args: NangoProxyArgs) => {
    calls.push(args)
    return args.endpoint === '/conversations.open' ? { data: { channel: { id: 'D42' } } } : { data: { ok: true } }
  }
  await spec.run(conn, { user: 'U777', text: 'hello' }, proxy)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].endpoint, '/conversations.open')
  assert.deepEqual(calls[0].data, { users: 'U777' })
  assert.equal(calls[1].endpoint, '/chat.postMessage')
  assert.deepEqual(calls[1].data, { channel: 'D42', text: 'hello' })
})

test('salesforce_query → GET /query with the SOQL in q', async () => {
  const c = await run('salesforce_query', { soql: 'SELECT Id FROM Account' })
  assert.equal(c.method, 'GET')
  assert.equal(c.endpoint, '/services/data/v60.0/query')
  assert.equal((c.params as { q: string }).q, 'SELECT Id FROM Account')
})

test('monday_create_item passes board_id/item_name as GraphQL variables (no injection)', async () => {
  const c = await run('monday_create_item', { boardId: '123', itemName: 'Say "hi"' })
  assert.equal(c.endpoint, '/v2')
  const data = c.data as { query: string; variables: { boardId: string; itemName: string } }
  // Values ride in variables, not interpolated into the query string.
  assert.ok(data.query.includes('create_item') && data.query.includes('$boardId') && data.query.includes('$itemName'))
  assert.ok(!data.query.includes('123') && !data.query.includes('Say'))
  assert.deepEqual(data.variables, { boardId: '123', itemName: 'Say "hi"' })
})

test('path segments from args are URL-encoded (no traversal)', async () => {
  const c = await run('salesforce_get_record', { sobject: 'Account', id: '../../limits' })
  assert.equal(c.endpoint, '/services/data/v60.0/sobjects/Account/..%2F..%2Flimits')
})

test('toolCountForConfigKey counts provider + delivery tools; 0 for unknown keys', async () => {
  const { NANGO_TOOL_COUNT_BY_CONFIG_KEY, toolCountForConfigKey } = await import('../provider-tools')

  // Unknown dashboard slug → 0 (connectable but no agent tool resolves it).
  assert.equal(toolCountForConfigKey('definitely-not-a-provider'), 0)

  // Every canonical config key resolves to a positive count.
  for (const keys of Object.values(PROVIDER_CONFIG_KEYS)) {
    assert.ok(toolCountForConfigKey(keys[0]) > 0, `${keys[0]} has ≥1 agent tool`)
  }

  // Slack's write tool lives in delivery.ts, so its count must exceed the
  // provider-tools-only read count — proving delivery tools are included.
  assert.ok(
    toolCountForConfigKey('slack') > toolsForProvider('slack').length,
    'slack count includes the delivery write tool',
  )

  // Aliased keys map to the same count as their canonical key.
  assert.equal(toolCountForConfigKey('atlassian'), toolCountForConfigKey('jira'))
  assert.equal(NANGO_TOOL_COUNT_BY_CONFIG_KEY['gmail'], NANGO_TOOL_COUNT_BY_CONFIG_KEY['google-mail'])
})

test('airtable_list_records → GET /v0/{base}/{table} (table name URL-encoded) with maxRecords', async () => {
  const c = await run('airtable_list_records', { baseId: 'app123', table: 'My Table', maxRecords: 5, view: 'Grid' })
  assert.equal(c.method, 'GET')
  assert.equal(c.endpoint, '/v0/app123/My%20Table')
  assert.equal((c.params as { maxRecords: number }).maxRecords, 5)
  assert.equal((c.params as { view: string }).view, 'Grid')
})

test('airtable_create_record → POST with fields; update_record → PATCH on the record path', async () => {
  const created = await run('airtable_create_record', { baseId: 'app1', table: 'T', fields: { Name: 'Acme' } })
  assert.equal(created.method, 'POST')
  assert.equal(created.endpoint, '/v0/app1/T')
  assert.deepEqual((created.data as { fields: unknown }).fields, { Name: 'Acme' })

  const updated = await run('airtable_update_record', { baseId: 'app1', table: 'T', recordId: 'rec9', fields: { Stage: 'Won' } })
  assert.equal(updated.method, 'PATCH')
  assert.equal(updated.endpoint, '/v0/app1/T/rec9')
  assert.deepEqual((updated.data as { fields: unknown }).fields, { Stage: 'Won' })
})

test('figma_get_file → GET /v1/files/{key}; post_comment → POST comments with message', async () => {
  const file = await run('figma_get_file', { fileKey: 'abc' })
  assert.equal(file.method, 'GET')
  assert.equal(file.endpoint, '/v1/files/abc')

  const comment = await run('figma_post_comment', { fileKey: 'abc', message: 'ship it' })
  assert.equal(comment.method, 'POST')
  assert.equal(comment.endpoint, '/v1/files/abc/comments')
  assert.equal((comment.data as { message: string }).message, 'ship it')
})

test('granola_list_notes → GET /v1/notes; empty filters stay out of the params', async () => {
  const all = await run('granola_list_notes', {})
  assert.equal(all.method, 'GET')
  assert.equal(all.endpoint, '/v1/notes')
  assert.deepEqual(all.params, {})

  const filtered = await run('granola_list_notes', { created_after: '2026-08-01', cursor: 'cur_9' })
  assert.deepEqual(filtered.params, { created_after: '2026-08-01', cursor: 'cur_9' })
})

test('granola_get_note → GET /v1/notes/{id} with transcript included, id URL-encoded', async () => {
  const c = await run('granola_get_note', { note_id: 'not_abc/../x' })
  assert.equal(c.method, 'GET')
  assert.equal(c.endpoint, '/v1/notes/not_abc%2F..%2Fx')
  assert.deepEqual(c.params, { include: 'transcript' })
  assert.equal(NANGO_PROVIDER_TOOLS.find((t) => t.name === 'granola_get_note')!.isWrite, false)
})

test('google drive: upload builds a multipart body with metadata name, parents, and base64 media', async () => {
  const call = await run('google_drive_upload_file', { filename: 'report.html', content: '<h1>Brief</h1>', folderId: 'folder123' })
  assert.equal(call.method, 'POST')
  assert.equal(call.endpoint, '/upload/drive/v3/files')
  assert.deepEqual(call.params, { uploadType: 'multipart', fields: 'id,name,mimeType,webViewLink' })
  const contentType = call.headers?.['Content-Type'] ?? ''
  const boundary = /multipart\/related; boundary="([^"]+)"/.exec(contentType)?.[1]
  assert.ok(boundary, 'content type carries the boundary')
  const body = String(call.data)
  assert.ok(body.includes(`--${boundary}`))
  assert.ok(body.includes('"name":"report.html"'), 'metadata part names the file')
  assert.ok(body.includes('"parents":["folder123"]'), 'metadata part carries the folder')
  assert.ok(body.includes('Content-Type: text/html'), 'mime type inferred from the extension')
  assert.ok(body.includes(Buffer.from('<h1>Brief</h1>', 'utf8').toString('base64')), 'media part is base64')
})

test('google drive: upload defaults mime by extension and requires content', async () => {
  const call = await run('google_drive_upload_file', { filename: 'notes.txt', content: 'plain' })
  assert.ok(String(call.data).includes('Content-Type: text/plain'))
  const spec = NANGO_PROVIDER_TOOLS.find((t) => t.name === 'google_drive_upload_file')!
  assert.equal(spec.isWrite, true)
  await assert.rejects(() => spec.run(conn, { filename: 'x.txt' }, async () => ({ data: {} })), /needs text content/)
})
