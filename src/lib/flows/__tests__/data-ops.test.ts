import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runDataOp } from '../data-ops'

const ok = (res: { output: unknown } | { error: string }): unknown => {
  assert.ok('output' in res, `expected output, got error: ${'error' in res ? res.error : ''}`)
  return res.output
}

const err = (res: { output: unknown } | { error: string }): string => {
  assert.ok('error' in res, 'expected an error result')
  return res.error
}

// ── compose ─────────────────────────────────────────────────────────────────

test('compose passes structured input through untouched', () => {
  const input = { deal: 'Acme', amount: 100 }
  assert.deepEqual(ok(runDataOp('compose', { input })), input)
})

test('compose exposes a JSON-looking string as structured output', () => {
  assert.deepEqual(ok(runDataOp('compose', { input: '{"a":1}' })), { a: 1 })
})

test('compose keeps plain text as text', () => {
  assert.equal(ok(runDataOp('compose', { input: 'hello world' })), 'hello world')
})

test('compose without an input fails with a plain-english message', () => {
  assert.match(err(runDataOp('compose', {})), /Compose needs/)
})

// ── parseJson ───────────────────────────────────────────────────────────────

test('parseJson parses a JSON string', () => {
  assert.deepEqual(ok(runDataOp('parseJson', { input: '{"score": 91, "tags": ["a"]}' })), { score: 91, tags: ['a'] })
})

test('parseJson passes already-structured input through', () => {
  assert.deepEqual(ok(runDataOp('parseJson', { input: [1, 2] })), [1, 2])
})

test('parseJson fails plainly on content that is not JSON', () => {
  const message = err(runDataOp('parseJson', { input: 'definitely not json' }))
  assert.match(message, /Parse JSON needs valid JSON/)
  assert.doesNotMatch(message, /SyntaxError/)
})

// ── join ────────────────────────────────────────────────────────────────────

test('join joins an array with the separator', () => {
  assert.equal(ok(runDataOp('join', { input: ['a', 'b', 'c'], separator: ' - ' })), 'a - b - c')
})

test('join defaults the separator to a comma', () => {
  assert.equal(ok(runDataOp('join', { input: ['a', 'b'] })), 'a,b')
})

test('join accepts a JSON array string', () => {
  assert.equal(ok(runDataOp('join', { input: '["x","y"]', separator: '|' })), 'x|y')
})

test('join stringifies object items as JSON', () => {
  assert.equal(ok(runDataOp('join', { input: [{ a: 1 }, 'b'], separator: ';' })), '{"a":1};b')
})

// Decision (tested contract): a non-array input is coerced to a single-item
// list, so join degrades to the item's text instead of failing.
test('join coerces a non-array input to a single item', () => {
  assert.equal(ok(runDataOp('join', { input: 'solo', separator: '-' })), 'solo')
})

test('join without an input fails with a plain-english message', () => {
  assert.match(err(runDataOp('join', {})), /Join needs/)
})

// ── csvTable ────────────────────────────────────────────────────────────────

test('csvTable renders records as CSV with a union header row', () => {
  const output = ok(runDataOp('csvTable', { input: [{ name: 'Acme', amount: 100 }, { name: 'Beta', owner: 'Dana' }] }))
  assert.equal(output, 'name,amount,owner\nAcme,100,\nBeta,,Dana')
})

test('csvTable quotes and escapes commas, quotes, and newlines', () => {
  const output = ok(runDataOp('csvTable', { input: [{ note: 'a,b', quote: 'say "hi"', multi: 'line1\nline2' }] }))
  assert.equal(output, 'note,quote,multi\n"a,b","say ""hi""","line1\nline2"')
})

test('csvTable quotes headers that contain commas', () => {
  const output = ok(runDataOp('csvTable', { input: [{ 'last, first': 'Doe, Jane' }] }))
  assert.equal(output, '"last, first"\n"Doe, Jane"')
})

test('csvTable keeps script tags as literal quoted text (no HTML meaning in CSV)', () => {
  const output = ok(runDataOp('csvTable', { input: [{ cell: '<script>alert(1)</script>' }] }))
  assert.equal(output, 'cell\n<script>alert(1)</script>')
})

test('csvTable wraps non-object items in a value column', () => {
  assert.equal(ok(runDataOp('csvTable', { input: ['a', 'b'] })), 'value\na\nb')
})

test('csvTable fails plainly on a non-list input', () => {
  assert.match(err(runDataOp('csvTable', { input: 'not a list' })), /Create CSV table needs a list/)
})

// ── htmlTable ───────────────────────────────────────────────────────────────

test('htmlTable renders records as an HTML table', () => {
  const output = ok(runDataOp('htmlTable', { input: [{ name: 'Acme', amount: 100 }] }))
  assert.equal(output, '<table><thead><tr><th>name</th><th>amount</th></tr></thead><tbody><tr><td>Acme</td><td>100</td></tr></tbody></table>')
})

test('htmlTable escapes script tags and every special character in cells', () => {
  const output = ok(runDataOp('htmlTable', { input: [{ cell: '<script>alert("x")</script>' }] })) as string
  assert.ok(!output.includes('<script>'))
  assert.ok(output.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'))
})

test('htmlTable escapes headers and ampersands/apostrophes', () => {
  const output = ok(runDataOp('htmlTable', { input: [{ '<b>col</b>': "Tom & Jerry's" }] })) as string
  assert.ok(output.includes('<th>&lt;b&gt;col&lt;/b&gt;</th>'))
  assert.ok(output.includes('<td>Tom &amp; Jerry&#39;s</td>'))
})

test('htmlTable fails plainly on a scalar, but treats one record as one row', () => {
  // A bare scalar is a genuine mis-wire — text piped into a records op.
  assert.match(err(runDataOp('htmlTable', { input: 'not a list' })), /Create HTML table needs a list/)
  // A single unwrapped record is the common real shape (an API that returned
  // exactly one match), and its obvious reading is a one-row table.
  const output = String(ok(runDataOp('htmlTable', { input: { name: 'Acme' } })))
  assert.ok(output.includes('<td>Acme</td>'), output)
})

// ── filterArray ─────────────────────────────────────────────────────────────

test('filterArray keeps items whose clauses all pass (eq)', () => {
  const input = [{ status: 'open', name: 'A' }, { status: 'closed', name: 'B' }, { status: 'open', name: 'C' }]
  const output = ok(runDataOp('filterArray', { input, clauses: [{ left: '{{item.status}}', op: 'eq', right: 'open' }] }))
  assert.deepEqual(output, [{ status: 'open', name: 'A' }, { status: 'open', name: 'C' }])
})

test('filterArray supports contains on item fields', () => {
  const input = [{ title: 'Renewal — Acme' }, { title: 'New logo — Beta' }]
  const output = ok(runDataOp('filterArray', { input, clauses: [{ left: '{{item.title}}', op: 'contains', right: 'Acme' }] }))
  assert.deepEqual(output, [{ title: 'Renewal — Acme' }])
})

test('filterArray ANDs multiple clauses', () => {
  const input = [{ stage: 'closed', amount: 50 }, { stage: 'closed', amount: 200 }]
  const output = ok(runDataOp('filterArray', {
    input,
    clauses: [
      { left: '{{item.stage}}', op: 'eq', right: 'closed' },
      { left: '{{item.amount}}', op: 'gt', right: '100' },
    ],
  }))
  assert.deepEqual(output, [{ stage: 'closed', amount: 200 }])
})

test('filterArray without clauses fails plainly', () => {
  assert.match(err(runDataOp('filterArray', { input: [1] })), /Filter array needs at least one condition/)
})

test('filterArray fails plainly on a non-list input', () => {
  assert.match(err(runDataOp('filterArray', { input: 'nope', clauses: [{ left: '{{item}}', op: 'eq', right: 'nope' }] })), /Filter array needs a list/)
})

// ── select ──────────────────────────────────────────────────────────────────

test('select maps items to objects with the configured fields', () => {
  const input = [{ name: 'Acme', amount: 100 }, { name: 'Beta', amount: 200 }]
  const output = ok(runDataOp('select', { input, fields: [{ name: 'company', value: '{{item.name}}' }] }))
  assert.deepEqual(output, [{ company: 'Acme' }, { company: 'Beta' }])
})

test('select maps a missing source field to null, not a crash', () => {
  const input = [{ name: 'Acme' }]
  const output = ok(runDataOp('select', {
    input,
    fields: [
      { name: 'company', value: '{{item.name}}' },
      { name: 'owner', value: '{{item.owner.email}}' },
    ],
  }))
  assert.deepEqual(output, [{ company: 'Acme', owner: null }])
})

test('select supports composed text values around item tokens', () => {
  const output = ok(runDataOp('select', { input: [{ name: 'Acme' }], fields: [{ name: 'line', value: 'Deal: {{item.name}}' }] }))
  assert.deepEqual(output, [{ line: 'Deal: Acme' }])
})

test('select preserves structured values for exact item tokens', () => {
  const output = ok(runDataOp('select', { input: [{ tags: ['a', 'b'] }], fields: [{ name: 'tags', value: '{{item.tags}}' }] }))
  assert.deepEqual(output, [{ tags: ['a', 'b'] }])
})

test('select without fields fails plainly', () => {
  assert.match(err(runDataOp('select', { input: [1], fields: [] })), /Select needs at least one field/)
})

test('select fails plainly on a non-list input', () => {
  assert.match(err(runDataOp('select', { input: 'nope', fields: [{ name: 'x', value: '{{item}}' }] })), /Select needs a list/)
})

test('split turns text into a trimmed list, defaulting to comma', () => {
  assert.deepEqual(runDataOp('split', { input: 'a, b , ,c' }), { output: ['a', 'b', 'c'] })
  assert.deepEqual(runDataOp('split', { input: 'one|two', separator: '|' }), { output: ['one', 'two'] })
})

test('replace swaps every occurrence and requires the find text', () => {
  assert.deepEqual(runDataOp('replace', { input: 'a-b-a', find: 'a', replaceWith: 'x' }), { output: 'x-b-x' })
  assert.deepEqual(runDataOp('replace', { input: 'a-b', find: '-' }), { output: 'ab' })
  const missing = runDataOp('replace', { input: 'abc' })
  assert.ok('error' in missing && /find/i.test(missing.error))
})

test('getItem takes by position with negatives from the end and clear range errors', () => {
  assert.deepEqual(runDataOp('getItem', { input: ['a', 'b', 'c'], index: '1' }), { output: 'b' })
  assert.deepEqual(runDataOp('getItem', { input: ['a', 'b', 'c'], index: '-1' }), { output: 'c' })
  assert.deepEqual(runDataOp('getItem', { input: ['a'] }), { output: 'a' })
  const outOfRange = runDataOp('getItem', { input: ['a'], index: '4' })
  assert.ok('error' in outOfRange && /1 item/.test(outOfRange.error))
  const notInt = runDataOp('getItem', { input: ['a'], index: 'first' })
  assert.ok('error' in notInt)
  const notList = runDataOp('getItem', { input: 'nope', index: '0' })
  assert.ok('error' in notList)
})

test('flatten unnests deeply', () => {
  assert.deepEqual(runDataOp('flatten', { input: [1, [2, [3, 4]], [5]] }), { output: [1, 2, 3, 4, 5] })
})

test('trim removes from the chosen end, defaulting to one from the start', () => {
  assert.deepEqual(runDataOp('trim', { input: ['a', 'b', 'c'] }), { output: ['b', 'c'] })
  assert.deepEqual(runDataOp('trim', { input: ['a', 'b', 'c'], count: '2', fromEnd: true }), { output: ['a'] })
  assert.deepEqual(runDataOp('trim', { input: ['a'], count: '5' }), { output: [] })
  const bad = runDataOp('trim', { input: ['a'], count: '-1' })
  assert.ok('error' in bad)
})

test('parseCsv reads records keyed by the header row, quotes and all', () => {
  const csv = 'name,note\n"Acme, Inc","said ""hi""\nsecond line"\nBeta,plain'
  assert.deepEqual(runDataOp('parseCsv', { input: csv }), {
    output: [
      { name: 'Acme, Inc', note: 'said "hi"\nsecond line' },
      { name: 'Beta', note: 'plain' },
    ],
  })
})

test('parseCsv round-trips what csvTable writes', () => {
  const records = [
    { account: 'Acme, Inc', owner: 'Jo "JJ" Ray' },
    { account: 'Beta', owner: 'Sam' },
  ]
  const csv = runDataOp('csvTable', { input: records })
  assert.ok('output' in csv)
  assert.deepEqual(runDataOp('parseCsv', { input: csv.output }), { output: records })
})

test('parseCsv rejects headerless input', () => {
  const res = runDataOp('parseCsv', { input: '   \n' })
  assert.ok('error' in res)
})

// ── file references: text ops read a file's extracted content ────────────────

test('parseCsv reads a file reference by its extracted content', () => {
  const fileRef = { fileId: 'f1', filename: 'r.csv', mimeType: 'text/csv', size: 9, url: '/api/files/f1', content: 'a,b\n1,2' }
  assert.deepEqual(ok(runDataOp('parseCsv', { input: fileRef })), [{ a: '1', b: '2' }])
})

test('parseJson reads a file reference by its extracted content', () => {
  const fileRef = { fileId: 'f2', filename: 'r.json', mimeType: 'application/json', size: 9, url: '/api/files/f2', content: '{"x":1}' }
  assert.deepEqual(ok(runDataOp('parseJson', { input: fileRef })), { x: 1 })
})

// ── columnarToRecords: columns+rows APIs (Snowflake SQL API v2 &c.) ─────────

test('columnarToRecords maps Snowflake SQL API shape to records', () => {
  const res = runDataOp('columnarToRecords', {
    input: {
      resultSetMetaData: { rowType: [{ name: 'ACCOUNTNAME' }, { name: 'DF_ENTITLED' }] },
      data: [['Acme', true], ['Globex', false]],
    },
  })
  assert.deepEqual(res, { output: [{ ACCOUNTNAME: 'Acme', DF_ENTITLED: true }, { ACCOUNTNAME: 'Globex', DF_ENTITLED: false }] })
})

test('columnarToRecords maps generic columns/rows and passes record lists through', () => {
  assert.deepEqual(runDataOp('columnarToRecords', { input: { columns: ['a', 'b'], rows: [[1, 2]] } }), { output: [{ a: 1, b: 2 }] })
  const already = [{ a: 1 }, { a: 2 }]
  assert.deepEqual(runDataOp('columnarToRecords', { input: already }), { output: already })
})

test('columnarToRecords rejects shapes without columns and rows in plain english', () => {
  const res = runDataOp('columnarToRecords', { input: { foo: 'bar' } })
  assert.ok('error' in res && /column names and rows/.test(res.error))
})

// ── non-list inputs: the shape the flagged flows actually hit ───────────────
// An upstream step that returns ONE record, or nothing at all, used to make
// every list op report "the input wasn't a list" — including "get item 0",
// whose answer for a single record is obvious. These pin the three readings.

test('getItem takes the single record an upstream step returned unwrapped', () => {
  const record = { id: 7, name: 'Acme' }
  assert.deepEqual(runDataOp('getItem', { input: record }), { output: record })
  assert.deepEqual(runDataOp('getItem', { input: record, index: '-1' }), { output: record })
})

test('asking past the end of a one-record input still says so', () => {
  const res = err(runDataOp('getItem', { input: { id: 7 }, index: '1' }))
  assert.match(res, /has 1 item\b/, res)
})

test('an upstream step that produced nothing names THAT, not the input shape', () => {
  for (const input of [null, undefined, '']) {
    const res = err(runDataOp('getItem', { input }))
    // A shared blank guard already answers this case, and it answers it well:
    // the author's real problem is that the previous step returned nothing.
    assert.match(res, /came back empty/, `input ${JSON.stringify(input)} → ${res}`)
    assert.doesNotMatch(res, /wasn't a list/, `input ${JSON.stringify(input)} → ${res}`)
  }
})

test('a bare scalar is still a mis-wire and still fails', () => {
  assert.match(err(runDataOp('getItem', { input: 'just some text' })), /wasn't a list/)
  assert.match(err(runDataOp('getItem', { input: 42 })), /wasn't a list/)
})

test('the other list ops read a single record the same way', () => {
  assert.deepEqual(
    ok(runDataOp('select', { input: { name: 'Acme' }, fields: [{ name: 'n', value: '{{item.name}}' }] })),
    [{ n: 'Acme' }],
  )
  assert.deepEqual(
    ok(runDataOp('filterArray', { input: { n: 1 }, clauses: [{ left: '{{item.n}}', op: 'eq', right: '1' }] })),
    [{ n: 1 }],
  )
  // Nothing upstream is still surfaced, by the shared blank guard.
  assert.match(
    err(runDataOp('select', { input: null, fields: [{ name: 'n', value: '{{item.n}}' }] })),
    /came back empty/,
  )
})
