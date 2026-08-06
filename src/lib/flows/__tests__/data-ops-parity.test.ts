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

// ——— Date & Time (n8n's dedicated node) ———

describe('formatDate', () => {
  it('formats ISO input through YYYY/MM/DD/HH/mm/ss tokens in UTC', () => {
    assert.equal(out(runDataOp('formatDate', { input: '2026-08-06T14:30:05Z', format: 'YYYY-MM-DD HH:mm:ss' })), '2026-08-06 14:30:05')
  })
  it('defaults to YYYY-MM-DD and reads epoch seconds and millis', () => {
    assert.equal(out(runDataOp('formatDate', { input: 1754491805 })), '2025-08-06')
    assert.equal(out(runDataOp('formatDate', { input: 1754491805000 })), '2025-08-06')
  })
  it('fails plainly on a non-date', () => {
    const result = runDataOp('formatDate', { input: 'not a date' })
    assert.ok('error' in result && /couldn't be read/.test(result.error))
  })
})

describe('dateShift', () => {
  it('adds days and subtracts with a negative amount', () => {
    assert.equal(out(runDataOp('dateShift', { input: '2026-08-06T00:00:00Z', amount: '3', unit: 'days' })), '2026-08-09T00:00:00.000Z')
    assert.equal(out(runDataOp('dateShift', { input: '2026-08-06T00:00:00Z', amount: '-6', unit: 'hours' })), '2026-08-05T18:00:00.000Z')
  })
  it('clamps month math instead of rolling over (Jan 31 + 1 month = Feb 28)', () => {
    assert.equal(out(runDataOp('dateShift', { input: '2026-01-31T12:00:00Z', amount: '1', unit: 'months' })), '2026-02-28T12:00:00.000Z')
  })
  it('accepts singular unit names', () => {
    assert.equal(out(runDataOp('dateShift', { input: '2026-08-06T00:00:00Z', amount: '1', unit: 'week' })), '2026-08-13T00:00:00.000Z')
  })
})

describe('dateDiff', () => {
  it('counts whole units between two dates, negative when reversed', () => {
    assert.equal(out(runDataOp('dateDiff', { input: '2026-08-01T00:00:00Z', to: '2026-08-06T12:00:00Z', unit: 'days' })), 5)
    assert.equal(out(runDataOp('dateDiff', { input: '2026-08-06T00:00:00Z', to: '2026-08-01T00:00:00Z', unit: 'days' })), -5)
  })
  it('does not count a partial month', () => {
    assert.equal(out(runDataOp('dateDiff', { input: '2026-01-31T00:00:00Z', to: '2026-02-28T00:00:00Z', unit: 'months' })), 0)
    assert.equal(out(runDataOp('dateDiff', { input: '2026-01-15T00:00:00Z', to: '2026-03-15T00:00:00Z', unit: 'months' })), 2)
  })
})

describe('datePart', () => {
  it('picks numeric and named parts', () => {
    const input = '2026-08-06T14:30:05Z' // a Thursday
    assert.equal(out(runDataOp('datePart', { input, part: 'year' })), 2026)
    assert.equal(out(runDataOp('datePart', { input, part: 'month' })), 8)
    assert.equal(out(runDataOp('datePart', { input, part: 'weekday' })), 'Thursday')
    assert.equal(out(runDataOp('datePart', { input, part: 'time' })), '14:30')
  })
  it('defaults to the calendar date and rejects unknown parts', () => {
    assert.equal(out(runDataOp('datePart', { input: '2026-08-06T14:30:05Z' })), '2026-08-06')
    assert.ok('error' in runDataOp('datePart', { input: '2026-08-06T14:30:05Z', part: 'fortnight' }))
  })
})

// ——— Rename fields (n8n Rename Keys) ———

describe('renameKeys', () => {
  it('renames keys on an object and every record of a list', () => {
    const fields = [{ name: 'acct_nm', value: 'account_name' }]
    assert.deepEqual(out(runDataOp('renameKeys', { input: { acct_nm: 'Acme', other: 1 }, fields })), { account_name: 'Acme', other: 1 })
    assert.deepEqual(out(runDataOp('renameKeys', { input: [{ acct_nm: 'A' }, { acct_nm: 'B', keep: true }], fields })), [
      { account_name: 'A' },
      { account_name: 'B', keep: true },
    ])
  })
  it('leaves missing keys alone and requires at least one rename', () => {
    assert.deepEqual(out(runDataOp('renameKeys', { input: { other: 1 }, fields: [{ name: 'gone', value: 'newName' }] })), { other: 1 })
    assert.ok('error' in runDataOp('renameKeys', { input: { a: 1 }, fields: [] }))
  })
})

// ——— Markdown ⇄ HTML (n8n Markdown node) ———

describe('markdownToHtml', () => {
  it('converts headings, emphasis, links, lists, and fences', () => {
    const html = out(runDataOp('markdownToHtml', {
      input: '# Title\n\nSome **bold** and *italic* with [a link](https://x.test).\n\n- one\n- two\n\n```\ncode()\n```',
    })) as string
    assert.match(html, /<h1>Title<\/h1>/)
    assert.match(html, /<strong>bold<\/strong>/)
    assert.match(html, /<em>italic<\/em>/)
    assert.match(html, /<a href="https:\/\/x\.test">a link<\/a>/)
    assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/)
    assert.match(html, /<pre><code>code\(\)<\/code><\/pre>/)
  })
  it('renders pipe tables', () => {
    const html = out(runDataOp('markdownToHtml', { input: '| a | b |\n|---|---|\n| 1 | 2 |' })) as string
    assert.match(html, /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody><\/table>/)
  })
  it('escapes raw HTML and refuses script URLs — the output is safe to embed', () => {
    const html = out(runDataOp('markdownToHtml', { input: '<script>alert(1)</script> [x](javascript:alert(1))' })) as string
    assert.doesNotMatch(html, /<script>/)
    assert.doesNotMatch(html, /href="javascript:/)
  })
})

describe('htmlToMarkdown', () => {
  it('converts the common structural tags back to markdown', () => {
    const md = out(runDataOp('htmlToMarkdown', {
      input: '<h2>Title</h2><p>Some <strong>bold</strong> and <em>italic</em> with <a href="https://x.test">a link</a>.</p><ul><li>one</li><li>two</li></ul>',
    })) as string
    assert.match(md, /## Title/)
    assert.match(md, /\*\*bold\*\*/)
    assert.match(md, /\*italic\*/)
    assert.match(md, /\[a link\]\(https:\/\/x\.test\)/)
    assert.match(md, /- one\n- two/)
  })
  it('decodes entities and drops script/style wholesale', () => {
    const md = out(runDataOp('htmlToMarkdown', { input: '<p>a &amp; b</p><script>alert(1)</script><style>p{}</style>' })) as string
    assert.equal(md, 'a & b')
  })
})

// ——— XML ⇄ JSON (n8n XML node) ———

describe('xmlParse', () => {
  it('parses elements, attributes, repeats, and CDATA', () => {
    const xml = '<?xml version="1.0"?><order id="7"><item sku="a">2</item><item sku="b">5</item><note><![CDATA[rush & ship]]></note></order>'
    assert.deepEqual(out(runDataOp('xmlParse', { input: xml })), {
      order: {
        '@id': '7',
        item: [
          { '@sku': 'a', '#text': '2' },
          { '@sku': 'b', '#text': '5' },
        ],
        note: 'rush & ship',
      },
    })
  })
  it('fails plainly on malformed XML', () => {
    const result = runDataOp('xmlParse', { input: '<a><b></a>' })
    assert.ok('error' in result && /well-formed XML/.test(result.error))
  })
})

describe('xmlBuild', () => {
  it('round-trips: a single top-level key becomes the root, @keys attributes, arrays repeat', () => {
    const built = out(runDataOp('xmlBuild', {
      input: { order: { '@id': '7', item: [{ '@sku': 'a', '#text': '2' }, 'plain'], empty: null } },
    })) as string
    assert.equal(
      built,
      '<?xml version="1.0" encoding="UTF-8"?><order id="7"><item sku="a">2</item><item>plain</item><empty/></order>',
    )
  })
  it('escapes markup in values and wraps multi-key objects in a root', () => {
    const built = out(runDataOp('xmlBuild', { input: { a: '<b>&', c: 1 } })) as string
    assert.equal(built, '<?xml version="1.0" encoding="UTF-8"?><root><a>&lt;b&gt;&amp;</a><c>1</c></root>')
  })
})

// ——— Hardened parity on the existing ops ———

describe('multi-field keys (n8n parity)', () => {
  it('sort orders by several comma-separated fields in turn', () => {
    const result = out(runDataOp('sort', { input: deals, by: 'owner, amount' })) as typeof deals
    assert.deepEqual(result.map((deal) => deal.name), ['Mid', 'Acme', 'Zeta'])
  })
  it('removeDuplicates keys on several fields together', () => {
    const rows = [
      { a: 1, b: 1, tag: 'first' },
      { a: 1, b: 2, tag: 'kept — b differs' },
      { a: 1, b: 1, tag: 'dropped' },
    ]
    const result = out(runDataOp('removeDuplicates', { input: rows, by: 'a, b' })) as typeof rows
    assert.deepEqual(result.map((row) => row.tag), ['first', 'kept — b differs'])
  })
  it('aggregate with several fields returns one object of value-lists per field', () => {
    assert.deepEqual(out(runDataOp('aggregate', { input: deals, by: 'name, amount' })), {
      name: ['Acme', 'Zeta', 'Mid'],
      amount: [300, 100, 200],
    })
  })
  it('summarize groups by several fields and keeps each on the row', () => {
    const rows = [
      { region: 'west', tier: 'a', amount: 1 },
      { region: 'west', tier: 'b', amount: 2 },
      { region: 'west', tier: 'a', amount: 3 },
    ]
    const result = out(runDataOp('summarize', { input: rows, by: 'region, tier', aggregations: [{ field: 'amount', op: 'sum' }] })) as Record<string, unknown>[]
    assert.deepEqual(result, [
      { region: 'west', tier: 'a', sum_amount: 4 },
      { region: 'west', tier: 'b', sum_amount: 2 },
    ])
  })
})

describe('summarize aggregation modes (n8n parity)', () => {
  it('countUnique, concat, and append', () => {
    const result = out(runDataOp('summarize', {
      input: deals,
      aggregations: [
        { field: 'owner', op: 'countUnique', name: 'owners' },
        { field: 'name', op: 'concat', name: 'names' },
        { field: 'amount', op: 'append', name: 'amounts' },
      ],
    })) as Record<string, unknown>[]
    assert.deepEqual(result, [{ owners: 2, names: 'Acme, Zeta, Mid', amounts: [300, 100, 200] }])
  })
})

describe('flatten as Split Out (n8n parity)', () => {
  it('with a field, each element becomes its own item carrying the other fields', () => {
    const input = [
      { account: 'Acme', contacts: ['ana', 'bo'] },
      { account: 'Zeta', contacts: ['cy'] },
    ]
    assert.deepEqual(out(runDataOp('flatten', { input, by: 'contacts' })), [
      { account: 'Acme', contacts: 'ana' },
      { account: 'Acme', contacts: 'bo' },
      { account: 'Zeta', contacts: 'cy' },
    ])
  })
  it('without a field it still deep-flattens nested lists', () => {
    assert.deepEqual(out(runDataOp('flatten', { input: [[1, [2]], [3]] })), [1, 2, 3])
  })
})

describe('filterArray match mode (n8n parity)', () => {
  const clauses = [
    { left: '{{item.owner}}', op: 'eq' as const, right: 'ana' },
    { left: '{{item.amount}}', op: 'gt' as const, right: '250' },
  ]
  it('all (default) requires every condition; any requires one', () => {
    // Acme passes both clauses; Mid passes only the owner clause; Zeta neither.
    const all = out(runDataOp('filterArray', { input: deals, clauses })) as typeof deals
    assert.deepEqual(all.map((deal) => deal.name), ['Acme'])
    const any = out(runDataOp('filterArray', { input: deals, clauses, match: 'any' })) as typeof deals
    assert.deepEqual(any.map((deal) => deal.name), ['Acme', 'Mid'])
  })
})

describe('nested field names (n8n Set parity)', () => {
  it('compose builds nested objects from dotted names', () => {
    assert.deepEqual(out(runDataOp('compose', {
      input: { city: 'Oslo' },
      fields: [{ name: 'billing.city', value: '{{item.city}}' }, { name: 'billing.tier', value: 'gold' }],
    })), { billing: { city: 'Oslo', tier: 'gold' } })
  })
  it('select maps dotted names per item', () => {
    assert.deepEqual(out(runDataOp('select', {
      input: [{ name: 'Acme' }],
      fields: [{ name: 'meta.label', value: '{{item.name}}' }],
    })), [{ meta: { label: 'Acme' } }])
  })
})
