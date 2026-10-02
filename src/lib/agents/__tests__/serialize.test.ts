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
