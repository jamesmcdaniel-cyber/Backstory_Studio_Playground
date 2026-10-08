import test from 'node:test'
import assert from 'node:assert/strict'
import { artifactPermissions } from '../sharing'
import { ArtifactToolClient } from '../tools'
import { configurableAgentScope, listableAgentScope } from '@/lib/server/visibility'

test('a personal template copy grants content editing only to its owner, even against admin/editor grants', () => {
  const copy = { userId: 'owner', workspaceAccess: 'edit', editorIds: ['other'], templateSourceId: 'source' }
  assert.deepEqual(artifactPermissions({ userId: 'owner', can: () => true }, copy), { canEdit: true, canShare: false, canConfigure: false, reason: 'owner' })
  assert.deepEqual(artifactPermissions({ userId: 'other', can: () => true }, copy), { canEdit: false, canShare: false, canConfigure: false, reason: 'view_only' })
  assert.equal(configurableAgentScope('owner').artifactTemplateCopyId, null)
  // Its copilot is listed for its owner (it is that artifact's agent), a guest's never is.
  assert.deepEqual(listableAgentScope('owner').type, { not: 'guest_copilot' })
  assert.equal('artifactTemplateCopyId' in listableAgentScope('owner'), false)
})

test('restricted artifact tools reject variants and ROI/repository actions before touching the database', async () => {
  const client = new ArtifactToolClient('org', 'owner', { artifactId: 'copy', executionId: 'run', request: null, templateCopy: true })
  for (const [name, args] of [
    ['edit_artifact', { saveAsNew: true }], ['revise_artifact', { saveAsNew: true }],
    ['list_roi_accounts', {}], ['start_roi_analysis', {}], ['update_roi_dashboard', {}],
    // The picture would be stored in the sharer's workspace and can cost a validator run.
    ['view_artifact_screenshot', {}],
  ] as const) {
    assert.match((await client.executeTool('', name, args) as { error: string }).error, /only read and revise your template copy/)
  }
})

test('a guest copy’s tool loading exposes only bound editing and inline computation, regardless of integration grants', async () => {
  const { loadTools } = await import('@/features/agents/execute-agent')
  const loaded = await loadTools('org', ['repository', 'gmail', 'slack', 'roi'], 'owner', 'connect everything', [], {}, 'agent', { artifactId: 'copy', kind: 'page', executionId: 'run', request: null, templateCopy: true, guestCopy: true })
  assert.equal(loaded.tools.length, 6)
  assert.deepEqual([...new Set([...loaded.bindings.values()].map(binding => binding.provider))].sort(), ['artifact', 'code'])
  assert.equal(loaded.tools.some(tool => /roi|repository|flow|agent|gmail|slack/.test(tool.name)), false)
  const code = [...loaded.bindings.values()].find(binding => binding.provider === 'code')!
  const denied = await code.client.executeTool(code.serverUrl, code.toolName, { code: 'return 1', documentIds: ['private-file'] }) as { error: string }
  assert.match(denied.error, /No readable document/)
})

test('a template copilot’s only data source is the shareable-MCP scope — never a person’s or the org’s live connections', async () => {
  const { shareableMcpConnectionScope, mcpConnectionScope } = await import('@/features/agents/tool-planes')
  assert.deepEqual(shareableMcpConnectionScope('org'), { organizationId: 'org', isActive: true, shareableWithCopilots: true })
  assert.equal('shareableWithCopilots' in mcpConnectionScope('org', 'user'), false, 'ordinary agents are unaffected by the flag')
  // The copilot branch of the tool loader must not reach for any other plane.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../../../features/agents/execute-agent.ts', import.meta.url), 'utf8')
  const start = source.indexOf('if (artifact?.templateCopy) {')
  const branch = source.slice(start, source.indexOf('// Planes that produced no usable client', start))
  assert.ok(start > 0 && branch.length > 200)
  assert.match(branch, /shareableOnly: true/)
  for (const forbidden of ['loadPeopleAiPlaneGroup', 'loadNangoPlaneGroups', 'loadNativePlaneGroups', 'getPeopleAiServiceClient']) {
    assert.equal(branch.includes(forbidden), false, `${forbidden} must never load for a template copilot`)
  }
})
