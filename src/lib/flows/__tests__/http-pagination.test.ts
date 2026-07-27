import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getByPath, setQueryParam, pageItems, optimizeForAi } from '../http-pagination'

test('getByPath reads nested and array paths', () => {
  assert.equal(getByPath({ a: { b: 2 } }, 'a.b'), 2)
  assert.equal(getByPath({ links: { next: 'u' } }, 'links.next'), 'u')
  assert.equal(getByPath({ items: [{ id: 9 }] }, 'items.0.id'), 9)
  assert.equal(getByPath({ a: 1 }, 'missing'), undefined)
})

test('setQueryParam sets or replaces a query parameter', () => {
  assert.equal(setQueryParam('https://x.com/api?a=1', 'page', 2), 'https://x.com/api?a=1&page=2')
  assert.equal(setQueryParam('https://x.com/api?page=1', 'page', 5), 'https://x.com/api?page=5')
})

test('pageItems uses the explicit path when given', () => {
  assert.deepEqual(pageItems({ data: { rows: [1, 2] } }, 'data.rows'), [1, 2])
})

test('pageItems auto-detects a list under common keys', () => {
  assert.deepEqual(pageItems({ results: [1, 2, 3] }, undefined), [1, 2, 3])
  assert.deepEqual(pageItems([9, 8], undefined), [9, 8])
  assert.deepEqual(pageItems({ nope: 1 }, undefined), [])
})

test('optimizeForAi drills into a data path', () => {
  assert.deepEqual(optimizeForAi({ payload: { rows: [{ a: 1 }] } }, { dataPath: 'payload.rows' }), [{ a: 1 }])
})

test('optimizeForAi keeps only selected fields of each record', () => {
  const rows = [{ id: 1, name: 'A', secret: 'x' }, { id: 2, name: 'B', secret: 'y' }]
  assert.deepEqual(optimizeForAi(rows, { fields: ['id', 'name'] }), [{ id: 1, name: 'A' }, { id: 2, name: 'B' }])
})

test('optimizeForAi caps the number of items', () => {
  assert.deepEqual(optimizeForAi([1, 2, 3, 4], { maxItems: 2 }), [1, 2])
})

test('optimizeForAi composes dataPath + fields + maxItems', () => {
  const body = { d: [{ id: 1, x: 't' }, { id: 2, x: 'u' }, { id: 3, x: 'v' }] }
  assert.deepEqual(optimizeForAi(body, { dataPath: 'd', fields: ['id'], maxItems: 2 }), [{ id: 1 }, { id: 2 }])
})
