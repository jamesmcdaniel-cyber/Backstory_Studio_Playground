import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dedupeResults, parseRelevance, type LibrarianResult } from '@/lib/librarian/relevance'

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
