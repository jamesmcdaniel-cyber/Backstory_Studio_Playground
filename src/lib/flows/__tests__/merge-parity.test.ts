import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mergeAllCombinations, mergeByKey, mergeByPosition } from '@/lib/flows/merge'
import { chunkItems, coerceFieldType } from '@/lib/flows/data-ops'

describe('mergeByPosition', () => {
  it('pairs the Nth item of each input into one record', () => {
    const left = [{ id: 1 }, { id: 2 }]
    const right = [{ name: 'a' }, { name: 'b' }]
    assert.deepEqual(mergeByPosition([left, right]), [{ id: 1, name: 'a' }, { id: 2, name: 'b' }])
  })

  it('drops the overhang by default and keeps it when asked', () => {
    const left = [{ id: 1 }, { id: 2 }, { id: 3 }]
    const right = [{ name: 'a' }]
    assert.deepEqual(mergeByPosition([left, right]), [{ id: 1, name: 'a' }])
    assert.deepEqual(mergeByPosition([left, right], true), [{ id: 1, name: 'a' }, { id: 2 }, { id: 3 }])
  })

  it('keeps the last value at a position when the items are not records', () => {
    assert.deepEqual(mergeByPosition([[1, 2], [3, 4]]), [3, 4])
  })
})

describe('mergeAllCombinations', () => {
  it('produces the cross product, merging records', () => {
    const result = mergeAllCombinations([[{ a: 1 }, { a: 2 }], [{ b: 'x' }, { b: 'y' }]])
    assert.deepEqual(result, [
      { a: 1, b: 'x' },
      { a: 1, b: 'y' },
      { a: 2, b: 'x' },
      { a: 2, b: 'y' },
    ])
  })

  it('ignores empty inputs rather than collapsing the product to nothing', () => {
    assert.deepEqual(mergeAllCombinations([[{ a: 1 }], []]), [{ a: 1 }])
  })
})

describe('mergeByKey unpaired control', () => {
  const left = [{ email: 'x@a.com', name: 'X' }, { email: 'only@left.com', name: 'L' }]
  const right = [{ email: 'x@a.com', phone: '111' }]

  it('keeps unmatched records by default — the behaviour it always had', () => {
    const result = mergeByKey([left, right], 'email') as Record<string, unknown>[]
    assert.equal(result.length, 2)
    assert.ok(result.some((row) => row.email === 'only@left.com'))
  })

  it('drops records that matched in only one input when unpaired are excluded', () => {
    const result = mergeByKey([left, right], 'email', false) as Record<string, unknown>[]
    assert.deepEqual(result, [{ email: 'x@a.com', name: 'X', phone: '111' }])
  })
})

describe('chunkItems (loop batch size)', () => {
  it('groups a list into batches, with a short final batch', () => {
    assert.deepEqual(chunkItems([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
  })

  it('treats a size below one as one, so a bad value cannot produce empty batches', () => {
    assert.deepEqual(chunkItems([1, 2], 0), [[1], [2]])
  })
})

describe('coerceFieldType', () => {
  it('coerces to the declared type', () => {
    assert.equal(coerceFieldType('42', 'number'), 42)
    assert.equal(coerceFieldType('yes', 'boolean'), true)
    assert.equal(coerceFieldType('no', 'boolean'), false)
    assert.equal(coerceFieldType(7, 'string'), '7')
    assert.deepEqual(coerceFieldType('solo', 'array'), ['solo'])
    assert.equal(coerceFieldType({ a: 1 }, 'string'), '{"a":1}')
  })

  it('leaves a value alone when it cannot honestly become the type', () => {
    assert.equal(coerceFieldType('not a number', 'number'), 'not a number', 'a bad number must stay visible, not become null')
    assert.equal(coerceFieldType('maybe', 'boolean'), 'maybe')
  })

  it('passes null and undefined through untouched', () => {
    assert.equal(coerceFieldType(null, 'number'), null)
    assert.equal(coerceFieldType(undefined, 'string'), undefined)
  })
})
