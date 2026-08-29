import test from 'node:test'
import assert from 'node:assert/strict'
import { DATA_TABLE_TOOLS, dataTableToolIsWrite } from '@/lib/data-tables/tools'
import { DATA_TABLE_COLUMN_TYPES } from '@/lib/data-tables/schema'

test('data-table tool names are unique and schemas are object-shaped', () => {
  const names = DATA_TABLE_TOOLS.map((tool) => tool.name)
  assert.equal(new Set(names).size, names.length)
  assert.ok(names.includes('data_table_get_rows'))
  assert.ok(names.includes('data_table_upsert_row'))
  assert.ok(names.includes('data_table_create_table'))
  for (const tool of DATA_TABLE_TOOLS) assert.equal(tool.inputSchema.type, 'object')
})

test('read and write tools are classified precisely and unknown tools fail closed', () => {
  assert.equal(dataTableToolIsWrite('data_table_list_tables'), false)
  assert.equal(dataTableToolIsWrite('data_table_get_rows'), false)
  assert.equal(dataTableToolIsWrite('data_table_insert_row'), true)
  assert.equal(dataTableToolIsWrite('data_table_update_row'), true)
  assert.equal(dataTableToolIsWrite('data_table_upsert_row'), true)
  assert.equal(dataTableToolIsWrite('data_table_delete_row'), true)
  assert.equal(dataTableToolIsWrite('unknown'), true)
  // Provisioning a table is a write: a `readonly` step policy must not be able
  // to create workspace state.
  assert.equal(dataTableToolIsWrite('data_table_create_table'), true)
})

test('create_table offers exactly the column types the schema validator accepts', () => {
  const create = DATA_TABLE_TOOLS.find((tool) => tool.name === 'data_table_create_table')!
  const properties = create.inputSchema.properties as unknown as Record<
    string,
    { items?: { properties?: Record<string, { enum?: readonly string[] }> } }
  >
  const offered = properties.columns?.items?.properties?.type?.enum
  // Advertising a type the validator rejects turns a reasonable model choice
  // into a failed run, so the enum is derived rather than retyped.
  assert.deepEqual(offered, [...DATA_TABLE_COLUMN_TYPES])
})
