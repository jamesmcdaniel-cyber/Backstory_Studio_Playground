import test from 'node:test'
import assert from 'node:assert/strict'
import {
  dataTableColumnsSchema,
  dataTableRowMatches,
  normalizeDataTableRow,
} from '@/lib/data-tables/schema'

const columns = [
  { name: 'account', type: 'string' as const, required: true },
  { name: 'score', type: 'number' as const, default: 0 },
  { name: 'active', type: 'boolean' as const },
  { name: 'reviewDate', type: 'date' as const },
]

test('column schemas reject duplicate names without case sensitivity', () => {
  const result = dataTableColumnsSchema.safeParse([
    { name: 'Account', type: 'string' },
    { name: 'account', type: 'number' },
  ])
  assert.equal(result.success, false)
})

test('row normalization applies defaults and enforces required typed columns', () => {
  assert.deepEqual(normalizeDataTableRow({ account: 'Acme', active: true }, columns), {
    account: 'Acme',
    score: 0,
    active: true,
  })
  assert.throws(() => normalizeDataTableRow({ score: 4 }, columns), /account.*required/i)
  assert.throws(() => normalizeDataTableRow({ account: 'Acme', score: '4' }, columns), /score.*number/i)
  assert.throws(() => normalizeDataTableRow({ account: 'Acme', extra: true }, columns), /Unknown data-table column: extra/)
})

test('partial normalization validates only supplied fields', () => {
  assert.deepEqual(normalizeDataTableRow({ score: 12 }, columns, { partial: true }), { score: 12 })
  assert.throws(() => normalizeDataTableRow({ score: Number.NaN }, columns, { partial: true }), /score.*number/i)
})

test('date and date-time validation rejects impossible or malformed values', () => {
  assert.throws(() => normalizeDataTableRow({ account: 'Acme', reviewDate: '2026-02-30' }, columns), /reviewDate.*date/i)
  assert.throws(
    () => normalizeDataTableRow({ occurredAt: 'not-a-date' }, [{ name: 'occurredAt', type: 'dateTime' }]),
    /occurredAt.*dateTime/i,
  )
})

test('exact row matching handles scalar and structural JSON values', () => {
  const row = { stage: 'won', score: 10, tags: ['priority'], owner: { id: 'u1' } }
  assert.equal(dataTableRowMatches(row, { stage: 'won', tags: ['priority'] }), true)
  assert.equal(dataTableRowMatches(row, { score: 11 }), false)
  assert.equal(dataTableRowMatches(row, { owner: { id: 'u2' } }), false)
})
