import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { citedItems, citedSources, dedupeResults, parseRelevance, type LibrarianResult } from '@/lib/librarian/relevance'

const item = (type: LibrarianResult['type'], title: string, subtitle = ''): LibrarianResult => ({
  type,
  id: `${type}-${title}-${subtitle}`,
  title,
  subtitle,
  href: '#',
})

describe('parseRelevance', () => {
  it('strips the RELEVANT line and returns the numbers the model stood behind', () => {
    const { answer, picked } = parseRelevance('Backstory MCP connects agents to deal data.\n\nRELEVANT: 1, 3', 4)
    assert.equal(answer, 'Backstory MCP connects agents to deal data.')
    assert.deepEqual(picked, [1, 3])
  })

  it('treats "none" as no links, leaving a self-contained answer', () => {
    const { answer, picked } = parseRelevance('A flow is a deterministic pipeline of steps.\nRELEVANT: none', 5)
    assert.equal(answer, 'A flow is a deterministic pipeline of steps.')
    assert.deepEqual(picked, [])
  })

  it('links nothing when the model omits the line — silence must not mean "link everything"', () => {
    const { answer, picked } = parseRelevance('Connect Slack from the Integrations page.', 6)
    assert.equal(answer, 'Connect Slack from the Integrations page.')
    assert.deepEqual(picked, [])
  })

  it('drops out-of-range and repeated picks', () => {
    assert.deepEqual(parseRelevance('x\nRELEVANT: 0, 2, 2, 9, -1', 3).picked, [2])
  })

  it('is case- and spacing-tolerant, and keeps the answer body intact', () => {
    const { answer, picked } = parseRelevance('Line one.\n\nLine two.\n\n  relevant :  2\n', 3)
    assert.equal(answer, 'Line one.\n\nLine two.')
    assert.deepEqual(picked, [2])
  })
})

describe('dedupeResults', () => {
  it('collapses the same item matched repeatedly, keeping the first', () => {
    const deduped = dedupeResults([
      item('agent', 'SalesAI Upsell Engine', 'Agent'),
      item('agent', 'SalesAI Upsell Engine', 'Agent'),
      item('agent', 'salesai upsell engine ', 'Agent'),
      item('run', 'SalesAI Upsell Engine', 'Run · cancelled'),
      item('run', 'SalesAI Upsell Engine', 'Run · cancelled'),
    ])
    assert.deepEqual(
      deduped.map((r) => `${r.type}:${r.title}`),
      ['agent:SalesAI Upsell Engine', 'run:SalesAI Upsell Engine'],
    )
  })

  it('keeps genuinely different items, including a flow and an agent of the same name', () => {
    const deduped = dedupeResults([
      item('flow', 'SalesAI Upsell Engine', 'Flow · draft'),
      item('agent', 'SalesAI Upsell Engine', 'Agent'),
      item('agent', 'Silence & Contract Monitor', 'Agent'),
    ])
    assert.equal(deduped.length, 3)
  })
})

// The two lists the model is shown share one numbering space: items 1..n, then
// the retrieved sources.
const ITEMS = [item('template', 'Meeting Brief'), item('flow', 'Renewal Prep')]
const SOURCES = [
  { title: 'Backstory MCP', url: 'https://help.backstory.ai/en/articles/1' },
  // Two library entries deliberately share one URL, as the live catalogue does.
  { title: 'Sales Digest', url: 'https://backstory-workflows.vercel.app/' },
  { title: 'Meeting Brief workflow', url: 'https://backstory-workflows.vercel.app/' },
]

describe('citedItems', () => {
  it('returns the workspace items the model numbered, in the order it gave', () => {
    assert.deepEqual(citedItems([2, 1], ITEMS).map((r) => r.title), ['Renewal Prep', 'Meeting Brief'])
  })

  it('ignores numbers past the items — those are sources, not items', () => {
    assert.deepEqual(citedItems([3, 4, 5], ITEMS), [])
  })

  it('returns nothing when the model stood behind nothing', () => {
    assert.deepEqual(citedItems([], ITEMS), [])
  })
})

describe('citedSources', () => {
  it('resolves a source number back past the items that precede it', () => {
    assert.deepEqual(citedSources([1, 3], ITEMS.length, SOURCES).map((s) => s.title), ['Backstory MCP'])
  })

  it('cites only the entry that was named, not every entry sharing its URL', () => {
    const cited = citedSources([4], ITEMS.length, SOURCES)
    assert.deepEqual(cited.map((s) => s.title), ['Sales Digest'])
  })

  it('falls back to everything retrieved when the model numbered no source', () => {
    assert.deepEqual(citedSources([1, 2], ITEMS.length, SOURCES).length, SOURCES.length)
    assert.deepEqual(citedSources([], ITEMS.length, SOURCES).length, SOURCES.length)
  })

  it('shows nothing when nothing was retrieved', () => {
    assert.deepEqual(citedSources([1, 2, 3], ITEMS.length, []), [])
  })

  it('drops a number past the end of both lists', () => {
    assert.deepEqual(citedSources([99], ITEMS.length, SOURCES).length, SOURCES.length)
  })
})
