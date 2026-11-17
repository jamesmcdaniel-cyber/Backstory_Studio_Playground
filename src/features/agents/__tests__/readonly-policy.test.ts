/**
 * "Read-only — no sending, creating, or deleting" is held to the runtime's own
 * write classification, not just to tool names.
 *
 * Each tool below writes and has a name without a write fragment, so the name
 * heuristic alone kept it on a read-only step.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discoveredToolsFromGroups } from '../agent-tool-resolution'
import { loadNativePlaneGroups, type ToolPlaneGroup } from '../tool-planes'
import { applyToolPolicy } from '@/lib/agents/tool-policy'
import { NANGO_PROVIDER_TOOLS } from '@/lib/nango/provider-tools'

const client = { executeTool: async () => ({}) }
const readonly = { mode: 'readonly' as const }

async function policed(groups: ToolPlaneGroup[]) {
  const { discovered } = discoveredToolsFromGroups(groups)
  const result = applyToolPolicy(discovered, readonly, (tool) => tool.name, (tool) => tool.binding)
  return { kept: result.tools.map((tool) => tool.name).sort(), removed: result.removed.sort() }
}

test('read-only withholds the HTTP plane and Data Table writes, and keeps Data Table reads', async () => {
  // Neither plane needs a credential, so the real loader builds them offline.
  const groups = await loadNativePlaneGroups('org', {
    providers: ['Data Tables', 'HTTP API'],
    httpEndpoints: [{ id: 'e1', name: 'lookup_customer', method: 'GET', url: 'https://api.example.com/customers' }],
  })
  const { kept, removed } = await policed(groups)
  for (const write of ['data_tables_data_table_insert_row', 'data_tables_data_table_upsert_row', 'http_request']) {
    assert.ok(removed.includes(write), `${write} is withheld`)
  }
  assert.ok(!kept.some((name) => name.startsWith('http_')), 'no HTTP tool, configured endpoints included, survives read-only')
  assert.ok(kept.includes('data_tables_data_table_get_rows'), 'reading a data table is still allowed')
})

test('read-only withholds a Nango write whose name says nothing (Sheets append row)', async () => {
  const spec = NANGO_PROVIDER_TOOLS.find((tool) => tool.name === 'google_sheets_append_row')!
  assert.ok(spec)
  const { removed } = await policed([{
    id: `nango:${spec.name}`, plane: 'nango', name: 'Google Sheets', provider: 'nango:google_sheets', serverUrl: 'nango',
    isWrite: spec.isWrite, client, tools: [{ name: spec.name, description: spec.description }],
  }])
  assert.deepEqual(removed, ['nango_google_sheets_append_row'])
})

test('an MCP tool the server reports as a write is withheld; an unannotated read is kept', async () => {
  const { kept, removed } = await policed([{
    id: 'conn', plane: 'mcp', name: 'CRM', provider: 'crm', serverUrl: 'https://crm.invalid/mcp', isWrite: false, client,
    tools: [
      { name: 'merge_records_into_account', description: 'x', annotations: { readOnlyHint: false } },
      { name: 'lookup', description: 'x' },
      { name: 'sync_contacts', description: 'x', annotations: { readOnlyHint: false, destructiveHint: true } },
    ],
  }])
  assert.deepEqual(kept, ['crm_lookup'])
  assert.ok(removed.includes('crm_sync_contacts'), 'reported writes go even when the name looks harmless')
})

test('a per-call classified tool (warehouse SQL) stays; its write calls are refused at execution', async () => {
  const { kept } = await policed([{
    id: 'native:snowflake', plane: 'native', name: 'Snowflake', provider: 'snowflake', serverUrl: 'https://x', isWrite: true, client,
    isWriteFor: (_tool, args) => !/^select/i.test(String(args.statement ?? '')),
    tools: [{ name: 'sql_query', description: 'SQL' }],
  }])
  assert.deepEqual(kept, ['snowflake_sql_query'])
})
