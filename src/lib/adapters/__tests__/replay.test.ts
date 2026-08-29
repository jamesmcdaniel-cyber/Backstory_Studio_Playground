import test from 'node:test'
import assert from 'node:assert/strict'
import { ADAPTER_FIXTURES, ADAPTER_FAMILIES, type AdapterFixture } from '@/lib/adapters/fixtures'
import { describeDrift, replayAdapterFixtures } from '@/lib/adapters/replay'

test('every golden fixture still replays cleanly through its live adapter', async () => {
  const report = await replayAdapterFixtures()
  assert.equal(
    report.failed,
    0,
    `Adapter drift detected:\n  ${describeDrift(report).join('\n  ')}`,
  )
  assert.equal(report.passed, report.total)
  assert.ok(report.total >= 10, 'the fixture set has not been quietly emptied')
})

test('fixture ids are unique and every declared family is actually covered', () => {
  const ids = ADAPTER_FIXTURES.map((fixture) => fixture.id)
  assert.equal(new Set(ids).size, ids.length)
  const covered = new Set(ADAPTER_FIXTURES.map((fixture) => fixture.family))
  // A family declared but uncovered is a monitor that reports "all clear" for
  // an adapter nothing ever exercised.
  assert.deepEqual([...covered].sort(), [...ADAPTER_FAMILIES].sort())
  for (const fixture of ADAPTER_FIXTURES) {
    assert.ok(fixture.pins.length > 20, `${fixture.id} says what it protects`)
  }
})

test('replay can be narrowed to one family', async () => {
  const report = await replayAdapterFixtures({ family: 'crm' })
  assert.ok(report.total > 0)
  assert.deepEqual(report.byFamily.map((entry) => entry.family), ['crm'])
})

test('a drifted adapter is reported with the contract it broke, not just a diff', async () => {
  // The fixture claims a parameter the real adapter does not send.
  const drifted: AdapterFixture = {
    kind: 'request',
    id: 'crm/deliberate-drift',
    family: 'crm',
    pins: 'SOQL travels as the `q` query parameter.',
    tool: 'salesforce_query',
    args: { soql: 'SELECT Id FROM Account' },
    expect: { method: 'GET', endpoint: '/services/data/v60.0/query', params: { query: 'SELECT Id FROM Account' } },
  }
  const report = await replayAdapterFixtures({ fixtures: [drifted] })
  assert.equal(report.failed, 1)
  const [line] = describeDrift(report)
  assert.match(line, /crm\/deliberate-drift/)
  assert.match(line, /pins: SOQL travels as the `q` query parameter/)
})

test('a fixture naming an adapter that no longer exists fails rather than passing vacuously', async () => {
  const report = await replayAdapterFixtures({
    fixtures: [{
      kind: 'request',
      id: 'crm/renamed-away',
      family: 'crm',
      pins: 'The adapter this fixture covers must still be registered.',
      tool: 'salesforce_query_v2_that_never_existed',
      args: {},
      expect: { method: 'GET', endpoint: '/whatever' },
    }],
  })
  // Skipping an unknown tool would let a rename silently drop coverage.
  assert.equal(report.failed, 1)
  assert.match(report.outcomes[0].error ?? '', /No adapter named/)
})

test('drift is listed before passes so a top-down reader meets the failure first', async () => {
  const report = await replayAdapterFixtures({
    fixtures: [
      ADAPTER_FIXTURES.find((fixture) => fixture.id === 'crm/salesforce-query')!,
      {
        kind: 'transform',
        id: 'identity/deliberate-drift',
        family: 'identity',
        pins: 'A message is identified by channel and ts.',
        transform: 'normalizeSlackEvent',
        input: { event: { type: 'message', channel: 'C1', ts: '1.1', user: 'U1' } },
        expect: { kind: 'nonsense' },
      },
    ],
  })
  assert.equal(report.outcomes[0].ok, false)
  assert.equal(report.outcomes[1].ok, true)
})

test('key order is not treated as drift', async () => {
  const report = await replayAdapterFixtures({
    fixtures: [{
      kind: 'request',
      id: 'delivery/key-order',
      family: 'delivery',
      pins: 'A request body is JSON; field order carries no meaning.',
      tool: 'slack_post_message',
      args: { channel: 'C123', text: 'hi' },
      expect: { endpoint: '/chat.postMessage', method: 'POST', data: { text: 'hi', channel: 'C123' } },
    }],
  })
  assert.equal(report.failed, 0)
})

test('the agent tool reports only the exceptions, plus what it checked', async () => {
  const { AdapterToolClient, adapterTools } = await import('@/lib/adapters/tools')
  const report = (await new AdapterToolClient().executeTool('', 'replay_adapter_fixtures', {})) as {
    total: number
    failed: number
    drift: unknown[]
    checked: string[]
  }
  assert.equal(report.failed, 0)
  assert.deepEqual(report.drift, [])
  // Echoing every passing fixture's golden back would be most of the response
  // and none of the information, so passes are named, not expanded.
  assert.equal(report.checked.length, report.total)

  const [tool] = adapterTools()
  assert.equal(tool.name, 'replay_adapter_fixtures')
  const schema = tool.inputSchema as { properties: { family: { enum: string[] } } }
  assert.deepEqual(schema.properties.family.enum, [...ADAPTER_FAMILIES])
})

test('the agent tool ignores an unrecognised family rather than checking nothing', async () => {
  const { AdapterToolClient } = await import('@/lib/adapters/tools')
  const client = new AdapterToolClient()
  const all = (await client.executeTool('', 'replay_adapter_fixtures', {})) as { total: number }
  const bogus = (await client.executeTool('', 'replay_adapter_fixtures', { family: 'nonsense' })) as { total: number }
  // Falling through to an empty run would report "0 failed" — an all-clear for
  // a check that never happened.
  assert.equal(bogus.total, all.total)
  await assert.rejects(() => client.executeTool('', 'unknown_tool', {}), /Unknown adapter tool/)
})
