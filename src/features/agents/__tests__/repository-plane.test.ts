import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_CONNECTORS } from '@/lib/connectors/registry'
import { REPOSITORY_TOOLS } from '@/lib/knowledge/tools'
import { MCP_MANAGEMENT_TOOLS } from '@/lib/mcp/server/tools'

test('the repository is a builtin connector and is never classified as a write plane', () => {
  const descriptor = BUILTIN_CONNECTORS.find((connector) => connector.providerId === 'repository')
  assert.ok(descriptor, 'repository must be registered as a builtin connector')
  assert.equal(descriptor!.isWrite, false)
})

test('the agent plane and the MCP surface expose the same repository tools', () => {
  const planeNames = REPOSITORY_TOOLS.map((tool) => tool.name).sort()
  const mcpNames = MCP_MANAGEMENT_TOOLS
    .filter((tool) => tool.name.startsWith('repository_'))
    .map((tool) => tool.name)
    .sort()
  assert.deepEqual(mcpNames, planeNames, 'the two surfaces must not drift apart')
})
