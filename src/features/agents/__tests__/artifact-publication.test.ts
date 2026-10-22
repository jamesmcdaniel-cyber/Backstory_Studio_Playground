import test from 'node:test'
import assert from 'node:assert/strict'
import { publishAgentDeliverable } from '../artifact-publication'
import { ArtifactValidatorUnavailableError } from '@/lib/artifacts/preflight'

// The run has already done its work (sent the email, posted to Slack) by the
// time its deliverable is published, so a save that fails never fails it.

test('a deliverable that saves is published without a warning', async () => {
  assert.deepEqual(await publishAgentDeliverable({ required: true, publish: async () => ({ id: 'validated' }) }), { published: { id: 'validated' }, warning: null, usedDraft: false })
})

test('a rendered app that does not save falls back to the agent\'s draft, and says so', async () => {
  const saved: string[] = []
  const result = await publishAgentDeliverable({
    required: true,
    publish: async () => { saved.push('rendered'); throw Error('Artifact failed browser startup validation: ReferenceError: x') },
    draft: async () => { saved.push('draft'); return { id: 'draft-version' } },
  })
  assert.deepEqual(saved, ['rendered', 'draft'])
  assert.deepEqual(result.published, { id: 'draft-version' })
  assert.equal(result.usedDraft, true)
  assert.match(result.warning ?? '', /draft was saved instead.*ReferenceError: x/)
})

test('when neither saves, the run completes with a visible warning instead of failing', async () => {
  const result = await publishAgentDeliverable({ required: true, publish: async () => { throw Error('interaction failed') }, draft: async () => { throw Error('still broken') } })
  assert.equal(result.published, null)
  assert.equal(result.usedDraft, false)
  assert.match(result.warning ?? '', /not saved as an artifact.*still broken/i)
  const absent = await publishAgentDeliverable({ required: true, publish: async () => null })
  assert.match(absent.warning ?? '', /not saved as an artifact.*no artifact version was published/i)
})

test('a validator outage is not retried on the draft, and reads as an outage', async () => {
  let draftTried = false
  const result = await publishAgentDeliverable({ required: true, publish: async () => { throw new ArtifactValidatorUnavailableError() }, draft: async () => { draftTried = true; return { id: 'x' } } })
  assert.equal(draftTried, false, 'the draft would hit the same unavailable validator')
  assert.equal(result.published, null)
  assert.match(result.warning ?? '', /validator is unavailable/i)
})

test('ordinary prose does not require an artifact, and its best-effort registration stays quiet', async () => {
  assert.deepEqual(await publishAgentDeliverable({ required: false, publish: async () => null }), { published: null, warning: null, usedDraft: false })
  assert.deepEqual(await publishAgentDeliverable({ required: false, publish: async () => { throw Error('optional registration') } }), { published: null, warning: null, usedDraft: false })
})
