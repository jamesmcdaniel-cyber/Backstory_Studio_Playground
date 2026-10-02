import test from 'node:test'
import assert from 'node:assert/strict'
import { publishAgentDeliverable } from '../artifact-publication'

test('required artifacts cannot complete after rejection or absent publication', async () => {
  await assert.rejects(publishAgentDeliverable(true, async () => { throw Error('interaction failed') }), /Artifact publication failed: interaction failed/)
  await assert.rejects(publishAgentDeliverable(true, async () => null), /No artifact version was published/)
  assert.deepEqual(await publishAgentDeliverable(true, async () => ({ id: 'validated' })), { id: 'validated' })
})

test('ordinary prose does not require an artifact', async () => {
  assert.equal(await publishAgentDeliverable(false, async () => null), null)
  assert.equal(await publishAgentDeliverable(false, async () => { throw Error('optional registration') }), null)
})
