import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ARTIFACT_AGENT_TEMPLATE_ID, serializeAgent } from '../serialize'

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'a1', description: 'Agent', objective: 'Do the work', goal: null, metadata: {}, folder: null,
  teammateId: null, visibility: 'private', status: 'ACTIVE', priority: 'MEDIUM', schedule: {},
  createdAt: new Date(0), lastExecutedAt: null, executionCount: 0,
  ...overrides,
})

test('agents made for an artifact are flagged so agent lists can leave them out', () => {
  assert.equal(serializeAgent(row()).madeForArtifact, false)
  assert.equal(serializeAgent(row({ metadata: { templateId: 'builtin:roi-analyst' } })).madeForArtifact, false)
  assert.equal(serializeAgent(row({ metadata: { templateId: ARTIFACT_AGENT_TEMPLATE_ID } })).madeForArtifact, true)
  assert.equal(serializeAgent(row({ artifactTemplateCopyId: 'copy-1' })).madeForArtifact, true)
})

test('a template copy’s copilot carries its artifact, so its card can open that instead', () => {
  assert.equal(serializeAgent(row()).templateCopyArtifactId, null)
  assert.equal(serializeAgent(row({ artifactTemplateCopyId: 'copy-1' })).templateCopyArtifactId, 'copy-1')
})

/**
 * Private scopes an agent to its creator, so a non-creator editor choosing it
 * handed the agent away. The serializer tells each viewer whether the choice
 * is theirs, by the same rule PUT enforces.
 */
test('only the creator (or anyone, on a creatorless row) may change who sees an agent', () => {
  assert.equal(serializeAgent(row({ userId: 'creator' }), 'creator').canChangeVisibility, true)
  assert.equal(serializeAgent(row({ userId: 'creator' }), 'teammate').canChangeVisibility, false)
  assert.equal(serializeAgent(row({ userId: null }), 'teammate').canChangeVisibility, true)
  assert.equal('canChangeVisibility' in serializeAgent(row()), false, 'no viewer, no claim either way')
})
