import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  EXAMPLE_OUTPUT_CONTRACTS,
  EXAMPLE_REPORTS,
  EXAMPLE_SPECS,
  OUTPUT_CONTRACT_MARKER,
  outputContract,
  withOutputContract,
  type ReportSpec,
} from '@/lib/templates/example-reports'

const spec: ReportSpec = {
  eyebrow: 'Upsell intelligence report',
  title: 'Weekly sweep',
  sub: 'Scored the in-segment account universe.',
  pill: '18 of 23 scored · Action ready',
  stats: [
    ['🏆', '6', 'Accounts ready NOW'],
    ['💰', '$2.1M', 'Qualified pipeline'],
  ],
  summary: 'Six accounts are ready now. Close the expansion this week.',
  sections: [
    {
      kind: 'table',
      eyebrow: 'Evidence-backed analysis',
      heading: '🔎 Priority matrix',
      count: 'Top 5 of 18 scored',
      head: ['Tier', 'Account', { v: 'Readiness', c: 'right' }],
      rows: [[{ v: 'NOW', c: 'prio-high' }, 'Seismic', { v: '91', c: 'right' }]],
      note: 'Tiering: NOW ≥ 80 · MONITOR &lt; 50.',
    },
    { kind: 'note', heading: '📮 Executive digest', body: 'Segment health is improving.' },
  ],
  evidence: [['Backstory MCP', 'Opportunity data.', 'Updated 2h ago']],
  banner: '🎉 18 accounts scored · Digest emailed',
}

describe('outputContract', () => {
  const contract = outputContract(spec)

  it('names every advertised section, in the order the example renders them', () => {
    const order = [
      'Hero card',
      'Stat row',
      '✨ Executive summary',
      '🔎 Priority matrix',
      '📮 Executive digest',
      '🧾 Evidence trail',
      'Dark outcome banner',
    ]
    let cursor = -1
    for (const heading of order) {
      const at = contract.indexOf(heading)
      assert.ok(at > cursor, `expected "${heading}" after the previous section (got index ${at})`)
      cursor = at
    }
  })

  it('pins the exact stat labels and table columns the example advertises', () => {
    assert.ok(contract.includes('🏆 "Accounts ready NOW"'), 'expected the stat tiles with their emoji and labels')
    assert.ok(contract.includes('💰 "Qualified pipeline"'))
    assert.ok(contract.includes('exactly 2 tiles'), 'expected the tile count to be pinned')
    assert.ok(contract.includes('Tier | Account | Readiness'), 'expected the table columns, priority classes stripped')
    assert.ok(contract.includes('NOW · Seismic · 91'), 'expected a sample row so column semantics are unambiguous')
  })

  it('decodes entities so the instruction reads as prose, not markup', () => {
    assert.ok(contract.includes('MONITOR < 50'), 'expected &lt; decoded in the caption')
    assert.ok(!contract.includes('&lt;'), 'no HTML entities should survive into the instruction')
  })

  it('marks the example values as illustrative and forbids a Markdown recap', () => {
    assert.ok(contract.startsWith(OUTPUT_CONTRACT_MARKER))
    assert.ok(/illustrative/i.test(contract), 'expected the example values to be marked illustrative')
    assert.ok(/never reuse the example's numbers/i.test(contract), 'expected a no-copied-data rule')
    assert.ok(/code fence/i.test(contract), 'expected the no-code-fence rule')
    assert.ok(/email or post the report/i.test(contract), 'expected the delivered-elsewhere rule')
  })
})

describe('withOutputContract', () => {
  it('appends the contract after the template\'s own instructions', () => {
    const merged = withOutputContract('39-salesai-upsell-engine', 'You are the SalesAI Upsell Engine.')
    assert.ok(merged.startsWith('You are the SalesAI Upsell Engine.'), 'domain instructions stay first')
    assert.ok(merged.includes(OUTPUT_CONTRACT_MARKER), 'expected the contract appended')
    assert.ok(merged.includes('🔎 Priority matrix'), "expected THIS template's sections, not a generic shape")
  })

  it('is idempotent, so repeated enhancement never duplicates it', () => {
    const once = withOutputContract('01-sales-digest', 'Do the digest.')
    assert.equal(withOutputContract('01-sales-digest', once), once)
  })

  it('leaves instructions untouched when the template advertises no example', () => {
    assert.equal(withOutputContract('no-such-template', 'Do the work.'), 'Do the work.')
  })
})

describe('every built-in template', () => {
  const ids = Object.keys(EXAMPLE_SPECS)

  it('has an example report and a contract generated from the same spec', () => {
    assert.ok(ids.length >= 40, `expected the full built-in catalogue, got ${ids.length}`)
    for (const id of ids) {
      assert.ok(EXAMPLE_REPORTS[id]?.startsWith('<!doctype html>'), `${id}: expected a rendered example`)
      assert.ok(EXAMPLE_OUTPUT_CONTRACTS[id]?.includes(OUTPUT_CONTRACT_MARKER), `${id}: expected a contract`)
    }
  })

  it('describes sections that actually appear in its rendered example (no drift)', () => {
    for (const id of ids) {
      const html = EXAMPLE_REPORTS[id]
      const contract = EXAMPLE_OUTPUT_CONTRACTS[id]
      for (const section of EXAMPLE_SPECS[id].sections) {
        assert.ok(contract.includes(section.heading), `${id}: contract omits "${section.heading}"`)
        assert.ok(html.includes(section.heading), `${id}: example omits "${section.heading}"`)
      }
      assert.ok(contract.includes(EXAMPLE_SPECS[id].title), `${id}: contract omits the report title`)
      assert.ok(contract.includes('🧾 Evidence trail'), `${id}: contract omits the evidence trail`)
    }
  })
})
