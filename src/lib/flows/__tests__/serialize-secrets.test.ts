import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serializeFlow } from '@/lib/flows/serialize'

/**
 * The flow wire shape must not carry the webhook trigger secret's hash.
 *
 * Found by a QA sweep that seeded every secret-bearing column with a sentinel
 * and grepped every read endpoint's response: GET /api/flows and
 * GET /api/flows/[id] both echoed `trigger.webhookSecretHash`, because the
 * stored trigger JSON was serialized wholesale. It reached everyone who can
 * read the flow — including a view-only cross-workspace guest on a share link.
 */

const base = {
  id: 'f1',
  name: 'Flow',
  description: '',
  status: 'ACTIVE',
  graph: { nodes: [], edges: [] },
  visibility: 'shared',
  createdAt: new Date(0),
  updatedAt: new Date(0),
}

test('serializeFlow strips webhookSecretHash but keeps the rest of the trigger', () => {
  const out = serializeFlow({
    ...base,
    trigger: {
      type: 'webhook',
      responseMode: 'immediately',
      inputFields: [{ name: 'account', type: 'string', required: true }],
      webhookSecretHash: 'deadbeef'.repeat(8),
    },
  })
  const trigger = out.trigger as Record<string, unknown>
  assert.equal('webhookSecretHash' in trigger, false, 'the hash never goes on the wire')
  assert.equal(trigger.type, 'webhook', 'the trigger type survives')
  assert.equal(trigger.responseMode, 'immediately', 'webhook reply mode survives')
  assert.ok(Array.isArray(trigger.inputFields), 'declared input fields survive')
  assert.equal(JSON.stringify(out).includes('deadbeef'), false, 'and it is nowhere in the payload')
})

test('a view-only cross-workspace guest never receives the hash either', () => {
  const out = serializeFlow(
    { ...base, trigger: { type: 'webhook', webhookSecretHash: 'abc123' } },
    'someone-else',
    { role: 'view', external: true },
  )
  assert.equal(JSON.stringify(out).includes('abc123'), false)
})

test('a missing or malformed trigger still serializes to a usable default', () => {
  assert.deepEqual(serializeFlow({ ...base, trigger: null }).trigger, { type: 'manual' })
  assert.deepEqual(serializeFlow({ ...base, trigger: 'nonsense' }).trigger, { type: 'manual' })
  assert.deepEqual(serializeFlow({ ...base, trigger: ['nope'] }).trigger, { type: 'manual' })
})
