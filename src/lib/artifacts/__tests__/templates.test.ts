import test from 'node:test'
import assert from 'node:assert/strict'
import { artifactPermissions } from '../sharing'
import { ArtifactToolClient } from '../tools'
import { configurableAgentScope } from '@/lib/server/visibility'

test('a personal template copy grants content editing only to its owner, even against admin/editor grants', () => {
  const copy = { userId: 'owner', workspaceAccess: 'edit', editorIds: ['other'], templateSourceId: 'source' }
  assert.deepEqual(artifactPermissions({ userId: 'owner', can: () => true }, copy), { canEdit: true, canShare: false, canConfigure: false, reason: 'owner' })
  assert.deepEqual(artifactPermissions({ userId: 'other', can: () => true }, copy), { canEdit: false, canShare: false, canConfigure: false, reason: 'view_only' })
  assert.equal(configurableAgentScope('owner').artifactTemplateCopyId, null)
})

test('restricted artifact tools reject variants and ROI/repository actions before touching the database', async () => {
  const client = new ArtifactToolClient('org', 'owner', { artifactId: 'copy', executionId: 'run', request: null, templateCopy: true })
  for (const [name, args] of [
    ['edit_artifact', { saveAsNew: true }], ['revise_artifact', { saveAsNew: true }],
    ['list_roi_accounts', {}], ['start_roi_analysis', {}], ['update_roi_dashboard', {}],
  ] as const) {
    assert.match((await client.executeTool('', name, args) as { error: string }).error, /only read and revise your template copy/)
  }
})

test('template tool loading exposes only bound editing and inline computation, regardless of integration grants', async () => {
  const { loadTools } = await import('@/features/agents/execute-agent')
  const loaded = await loadTools('org', ['repository', 'gmail', 'slack', 'roi'], 'owner', 'connect everything', [], {}, 'agent', { artifactId: 'copy', kind: 'page', executionId: 'run', request: null, templateCopy: true })
  assert.equal(loaded.tools.length, 6)
  assert.deepEqual([...new Set([...loaded.bindings.values()].map(binding => binding.provider))].sort(), ['artifact', 'code'])
  assert.equal(loaded.tools.some(tool => /roi|repository|flow|agent|gmail|slack/.test(tool.name)), false)
  const code = [...loaded.bindings.values()].find(binding => binding.provider === 'code')!
  const denied = await code.client.executeTool(code.serverUrl, code.toolName, { code: 'return 1', documentIds: ['private-file'] }) as { error: string }
  assert.match(denied.error, /No readable document/)
})
