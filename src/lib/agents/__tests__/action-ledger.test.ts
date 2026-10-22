import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planeOfProvider, summarizeArgs, withActionLedger } from '../action-ledger'

test('the args summary keeps what identifies the call and drops what must not be kept', () => {
  const summary = summarizeArgs({
    channel: '#revenue',
    text: `Q3 numbers ${'x'.repeat(400)}`,
    apiKey: 'sk-live-should-never-be-kept',
    note: 'card 4111 1111 1111 1111 and ssn 123-45-6789',
    nested: { authorization: 'Bearer abc.def.ghi', fields: { Amount: 5000 } },
  })
  assert.equal(summary.channel, '#revenue')
  assert.match(String(summary.text), /^Q3 numbers x+… \(411 chars\)$/)
  assert.equal(summary.apiKey, '[REDACTED]')
  assert.equal(summary.note, 'card [number] and ssn [id]')
  assert.deepEqual(summary.nested, { authorization: '[REDACTED]', fields: { Amount: 5000 } })
})

test('a huge argument object keeps field names only', () => {
  const big = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`field${i}`, 'v'.repeat(190)]))
  const summary = summarizeArgs(big)
  assert.equal((summary.fields as string[]).length, 30)
  assert.match(String(summary.note), /field names only/)
})

test('plane follows the binding: nango, mcp, people.ai, or native', () => {
  assert.equal(planeOfProvider('nango:slack'), 'nango')
  assert.equal(planeOfProvider('acme_crm', 'conn-1'), 'mcp')
  assert.equal(planeOfProvider('backstory'), 'people_ai')
  assert.equal(planeOfProvider('snowflake'), 'native')
})

test('a read passes straight through without touching the ledger', async () => {
  // isWrite false: no database is needed for this path at all.
  const result = await withActionLedger(
    { organizationId: 'org', source: { kind: 'agent', agentTaskId: 'a', runId: 'r' }, actorUserId: 'u', provider: 'nango:slack', plane: 'nango', tool: 'slack_list_channels', args: {}, isWrite: false },
    async () => ({ channels: [] }),
  )
  assert.deepEqual(result, { channels: [] })
})
