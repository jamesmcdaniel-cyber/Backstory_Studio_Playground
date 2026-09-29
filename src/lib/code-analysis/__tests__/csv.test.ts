import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDelimited, isTabular } from '../csv'

test('parses a CSV into header-keyed rows', () => {
  const { columns, rows } = parseDelimited('rep,month,amount\nAna,2026-01,100\nBo,2026-01,50\n', 'deals.csv')
  assert.deepEqual(columns, ['rep', 'month', 'amount'])
  assert.deepEqual(rows, [
    { rep: 'Ana', month: '2026-01', amount: '100' },
    { rep: 'Bo', month: '2026-01', amount: '50' },
  ])
})

test('handles quotes, escaped quotes, embedded commas and newlines, CRLF and a BOM', () => {
  const text = '﻿name,note\r\n"Smith, J","said ""hi""\nthen left"\r\nLee,plain\r\n'
  const { rows } = parseDelimited(text, 'x.csv')
  assert.deepEqual(rows, [
    { name: 'Smith, J', note: 'said "hi"\nthen left' },
    { name: 'Lee', note: 'plain' },
  ])
})

test('detects tab-separated files and names blank or duplicate headers', () => {
  const { columns, rows } = parseDelimited('a\t\ta\n1\t2\t3', 'x.tsv')
  assert.deepEqual(columns, ['a', 'column_2', 'a_2'])
  assert.deepEqual(rows, [{ a: '1', column_2: '2', a_2: '3' }])
})

test('pads short rows so every row carries every column', () => {
  const { rows } = parseDelimited('a,b,c\n1,2', 'x.csv')
  assert.deepEqual(rows, [{ a: '1', b: '2', c: '' }])
})

test('recognizes tabular files by extension', () => {
  assert.equal(isTabular('Q3 pipeline.CSV'), true)
  assert.equal(isTabular('export.tsv'), true)
  assert.equal(isTabular('notes.md'), false)
})
