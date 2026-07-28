import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runDataOp } from '@/lib/flows/data-ops'

/**
 * The item-shaping ops added for n8n parity — Sort, Limit, Remove Duplicates,
 * Aggregate and Summarize are dedicated core nodes there — plus Compose's
 * object mode, which is n8n's Set/Edit Fields.
 */
const out = (result: ReturnType<typeof runDataOp>) => {
  assert.ok(!('error' in result), 'error' in result ? result.error : '')
  return (result as { output: unknown }).output
}

const deals = [
  { name: 'Acme', amount: 300, owner: 'ana' },
  { name: 'Zeta', amount: 100, owner: 'bo' },
  { name: 'Mid', amount: 200, owner: 'ana' },
]

describe('compose', () => {
  it('builds an object from named fields — the "hold a token for later" step', () => {
    const result = out(
      runDataOp('compose', {
        input: { body: { access_token: 'abc123', expires_in: 3600 } },
        fields: [
          { name: 'token', value: '{{item.body.access_token}}' },
          { name: 'header', value: 'Bearer {{item.body.access_token}}' },
        ],
      }),
    )
    assert.deepEqual(result, { token: 'abc123', header: 'Bearer abc123' })
  })

  it('keeps structure when a field maps an exact token', () => {
    const result = out(runDataOp('compose', { input: { a: { deep: [1, 2] } }, fields: [{ name: 'copy', value: '{{item.a}}' }] })) as Record<string, unknown>
    assert.deepEqual(result.copy, { deep: [1, 2] })
  })

  it('still passes the input through when no fields are declared', () => {
    assert.deepEqual(out(runDataOp('compose', { input: '{"a":1}' })), { a: 1 })
    assert.equal(out(runDataOp('compose', { input: 'plain text' })), 'plain text')
  })
})

describe('sort', () => {
  it('orders by a field, numerically where the values are numbers', () => {
    const result = out(runDataOp('sort', { input: deals, by: 'amount' })) as { name: string }[]
    assert.deepEqual(result.map((d) => d.name), ['Zeta', 'Mid', 'Acme'])
  })

  it('reverses on descending', () => {
    const result = out(runDataOp('sort', { input: deals, by: 'amount', descending: true })) as { name: string }[]
    assert.deepEqual(result.map((d) => d.name), ['Acme', 'Mid', 'Zeta'])
  })

  it('is stable — equal keys keep their input order', () => {
    const rows = [{ k: 1, id: 'a' }, { k: 1, id: 'b' }, { k: 0, id: 'c' }]
    const result = out(runDataOp('sort', { input: rows, by: 'k' })) as { id: string }[]
    assert.deepEqual(result.map((r) => r.id), ['c', 'a', 'b'])
  })

  it('sorts bare values when no field is named', () => {
    assert.deepEqual(out(runDataOp('sort', { input: [3, 1, 2] })), [1, 2, 3])
  })
})

describe('limit', () => {
  it('keeps the first N by default and the last N from the end', () => {
    assert.deepEqual(out(runDataOp('limit', { input: [1, 2, 3, 4, 5], count: '2' })), [1, 2])
    assert.deepEqual(out(runDataOp('limit', { input: [1, 2, 3, 4, 5], count: '2', fromEnd: true })), [4, 5])
  })

  it('rejects a non-numeric count rather than silently keeping everything', () => {
    const result = runDataOp('limit', { input: [1, 2], count: 'lots' })
    assert.ok('error' in result)
  })
})

describe('removeDuplicates', () => {
  it('de-duplicates on one field, keeping the first of each', () => {
    const result = out(runDataOp('removeDuplicates', { input: deals, by: 'owner' })) as { name: string }[]
    assert.deepEqual(result.map((d) => d.name), ['Acme', 'Zeta'])
  })

  it('de-duplicates whole records when no field is named', () => {
    const rows = [{ a: 1 }, { a: 1 }, { a: 2 }]
    assert.deepEqual(out(runDataOp('removeDuplicates', { input: rows })), [{ a: 1 }, { a: 2 }])
  })
})

describe('aggregate', () => {
  it('collects one field into a list', () => {
    assert.deepEqual(out(runDataOp('aggregate', { input: deals, by: 'name' })), ['Acme', 'Zeta', 'Mid'])
  })

  it('returns the whole list as one value when no field is named', () => {
    assert.deepEqual(out(runDataOp('aggregate', { input: deals })), deals)
  })
})

describe('summarize', () => {
  it('groups by a field and computes per-group aggregations', () => {
    const result = out(
      runDataOp('summarize', {
        input: deals,
        by: 'owner',
        aggregations: [
          { field: 'amount', op: 'sum', name: 'total' },
          { field: 'amount', op: 'count', name: 'deals' },
        ],
      }),
    ) as Record<string, unknown>[]
    assert.deepEqual(result, [
      { owner: 'ana', total: 500, deals: 2 },
      { owner: 'bo', total: 100, deals: 1 },
    ])
  })

  it('summarizes the whole list as one group when no group field is given', () => {
    const result = out(
      runDataOp('summarize', { input: deals, aggregations: [{ field: 'amount', op: 'avg', name: 'avg' }] }),
    ) as Record<string, unknown>[]
    assert.equal(result.length, 1)
    assert.equal(result[0].avg, 200)
  })

  it('supports min and max, and names a column when the author does not', () => {
    const result = out(
      runDataOp('summarize', { input: deals, aggregations: [{ field: 'amount', op: 'min' }, { field: 'amount', op: 'max' }] }),
    ) as Record<string, unknown>[]
    assert.equal(result[0].min_amount, 100)
    assert.equal(result[0].max_amount, 300)
  })

  it('needs something to calculate', () => {
    assert.ok('error' in runDataOp('summarize', { input: deals, by: 'owner' }))
  })
})

describe('list ops reject non-lists rather than guessing', () => {
  it('errors clearly for each', () => {
    for (const op of ['sort', 'limit', 'removeDuplicates', 'aggregate', 'summarize'] as const) {
      const result = runDataOp(op, { input: 'not a list' })
      assert.ok('error' in result, `${op} should refuse a non-list`)
    }
  })
})
