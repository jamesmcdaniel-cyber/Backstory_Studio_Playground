import test from 'node:test'
import assert from 'node:assert/strict'
import { csvToDataTableRows, dataTableRowsToCsv, parseCsvRows } from '@/lib/data-tables/csv'

const columns = [
  { name: 'name', type: 'string' as const, required: true },
  { name: 'score', type: 'number' as const },
  { name: 'active', type: 'boolean' as const },
  { name: 'meta', type: 'object' as const },
]

test('CSV parsing handles BOM, commas, escaped quotes, and embedded newlines', () => {
  assert.deepEqual(parseCsvRows('\uFEFFname,note\r\n"Acme, Inc","said ""hi""\nagain"'), [
    ['name', 'note'],
    ['Acme, Inc', 'said "hi"\nagain'],
  ])
  assert.throws(() => parseCsvRows('name\n"unfinished'), /unterminated/i)
})

test('typed CSV import validates and converts values', () => {
  assert.deepEqual(csvToDataTableRows('name,score,active,meta\nAcme,12,true,"{""tier"":""A""}"', columns), [{
    name: 'Acme', score: 12, active: true, meta: { tier: 'A' },
  }])
  assert.throws(() => csvToDataTableRows('name,score\nAcme,nope', columns), /non-number/)
  assert.throws(() => csvToDataTableRows('name,unknown\nAcme,x', columns), /Unknown data-table column/)
})

test('CSV export preserves column order and neutralizes spreadsheet formulas', () => {
  const csv = dataTableRowsToCsv([{ name: '=HYPERLINK("bad")', score: 2, active: false, meta: { tier: 'A' } }], columns)
  assert.match(csv, /^name,score,active,meta\n/)
  assert.match(csv, /'=HYPERLINK/)
  assert.match(csv, /"{""tier"":""A""}"/)
})
