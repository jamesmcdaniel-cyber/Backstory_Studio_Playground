import test from 'node:test'
import assert from 'node:assert/strict'
import { DATA_TABLE_TOOLS, dataTableToolIsWrite } from '@/lib/data-tables/tools'

test('data-table tool names are unique and schemas are object-shaped', () => {
  const names = DATA_TABLE_TOOLS.map((tool) => tool.name)
  assert.equal(new Set(names).size, names.length)
  assert.ok(names.includes('data_table_get_rows'))
  assert.ok(names.includes('data_table_upsert_row'))
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
})
