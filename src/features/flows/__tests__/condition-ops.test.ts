import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evalClause } from '@/features/flows/context'
import { CONDITION_OPS, CONDITION_OP_LABELS, UNARY_CONDITION_OPS, type ConditionOp } from '@/lib/flows/graph'

/**
 * The operator set behind `condition`, `filter`, `switch`, and the
 * `filterArray` data op. n8n reaches the same expressiveness through
 * type-specific operator sets; we keep one flat list and coerce per operator,
 * so these lock in what each one means.
 */
const ctx = { steps: {}, vars: {}, trigger: { input: '' } } as never

const check = (left: string, op: ConditionOp, right = '', ignoreCase?: boolean) =>
  evalClause({ left, op, right, ...(ignoreCase === undefined ? {} : { ignoreCase }) }, ctx)

describe('text operators', () => {
  it('covers contains and its negation', () => {
    assert.equal(check('hello world', 'contains', 'world'), true)
    assert.equal(check('hello world', 'notContains', 'world'), false)
    assert.equal(check('hello world', 'notContains', 'mars'), true)
  })

  it('covers the prefix and suffix operators n8n has and we did not', () => {
    assert.equal(check('Acme Corporation', 'startsWith', 'Acme'), true)
    assert.equal(check('Acme Corporation', 'startsWith', 'Corp'), false)
    assert.equal(check('report.csv', 'endsWith', '.csv'), true)
    assert.equal(check('report.csv', 'endsWith', '.json'), false)
  })

  it('folds both sides when the clause asks to ignore case', () => {
    assert.equal(check('ACME', 'eq', 'acme'), false)
    assert.equal(check('ACME', 'eq', 'acme', true), true)
    assert.equal(check('Acme Corp', 'contains', 'CORP', true), true)
    assert.equal(check('Acme Corp', 'startsWith', 'acme', true), true)
  })

  it('applies ignore-case to a regex as a flag, not by mangling the pattern', () => {
    assert.equal(check('Acme-123', 'matches', '^acme-\\d+$'), false)
    assert.equal(check('Acme-123', 'matches', '^acme-\\d+$', true), true)
  })

  it('treats an invalid pattern as no match rather than throwing', () => {
    assert.equal(check('anything', 'matches', '([unclosed'), false)
  })
})

describe('presence operators', () => {
  it('distinguishes empty from present', () => {
    assert.equal(check('', 'isEmpty'), true)
    assert.equal(check('   ', 'isEmpty'), true, 'whitespace-only is empty once trimmed')
    assert.equal(check('x', 'isEmpty'), false)
    assert.equal(check('x', 'isNotEmpty'), true)
  })

  it('reads an unresolved value as absent, not as the word it rendered', () => {
    assert.equal(check('undefined', 'exists'), false)
    assert.equal(check('null', 'exists'), false)
    assert.equal(check('', 'exists'), false)
    assert.equal(check('0', 'exists'), true, 'a real zero exists')
    assert.equal(check('undefined', 'notExists'), true)
  })

  it('ignores the right-hand side entirely', () => {
    assert.equal(check('', 'isEmpty', 'whatever'), true)
    assert.equal(UNARY_CONDITION_OPS.has('isEmpty'), true)
    assert.equal(UNARY_CONDITION_OPS.has('contains'), false)
  })
})

describe('boolean operators', () => {
  it('accepts the ways a boolean arrives from JSON, a form, or a template', () => {
    for (const truthy of ['true', 'TRUE', 'yes', '1']) assert.equal(check(truthy, 'isTrue'), true, truthy)
    for (const falsy of ['false', 'FALSE', 'no', '0']) assert.equal(check(falsy, 'isFalse'), true, falsy)
    assert.equal(check('maybe', 'isTrue'), false)
    assert.equal(check('maybe', 'isFalse'), false)
  })
})

describe('date operators', () => {
  it('orders real dates chronologically, not alphabetically', () => {
    assert.equal(check('2026-01-05', 'before', '2026-01-10'), true)
    assert.equal(check('2026-01-10', 'before', '2026-01-05'), false)
    assert.equal(check('2026-01-10T09:00:00Z', 'after', '2026-01-10T08:00:00Z'), true)
    // Alphabetically "2026-1-5" > "2026-01-10"; chronologically it is earlier.
    assert.equal(check('2026-1-5', 'before', '2026-01-10'), true)
  })

  it('falls back to text ordering when a side is not a date', () => {
    assert.equal(check('alpha', 'before', 'beta'), true)
    assert.equal(check('beta', 'after', 'alpha'), true)
  })
})

describe('numeric operators still coerce', () => {
  it('orders numerically rather than as strings', () => {
    assert.equal(check('9', 'lt', '10'), true, '9 < 10 numerically, though "9" > "10" as text')
    assert.equal(check('10', 'gte', '10'), true)
    assert.equal(check('7', 'eq', '7'), true)
  })
})

describe('the operator catalogue', () => {
  it('gives every operator a plain-English label, as the UI contract requires', () => {
    for (const op of CONDITION_OPS) {
      const label = CONDITION_OP_LABELS[op]
      assert.ok(label && !label.includes('{{'), `${op} needs a plain-English label`)
    }
  })

  it('has no operator that the evaluator would silently ignore', () => {
    for (const op of CONDITION_OPS) {
      assert.doesNotThrow(() => check('a', op, 'b'), `${op} threw`)
    }
  })
})
