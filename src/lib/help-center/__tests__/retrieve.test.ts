import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { interleave, SOURCE_LABEL, type KnowledgeDoc, type KnowledgeSource } from '@/lib/help-center/retrieve'

const doc = (source: KnowledgeSource, title: string): KnowledgeDoc => ({
  source,
  title,
  url: `https://example.test/${title.toLowerCase().replace(/\s+/g, '-')}`,
  text: title,
})

describe('interleave', () => {
  it('takes from each source in turn, so one source cannot crowd out the others', () => {
    const merged = interleave([
      [doc('help', 'H1'), doc('help', 'H2'), doc('help', 'H3'), doc('help', 'H4')],
      [doc('developer', 'D1')],
      [doc('library', 'L1'), doc('library', 'L2')],
    ], 4)
    assert.deepEqual(merged.map((d) => d.title), ['H1', 'D1', 'L1', 'H2'])
  })

  it('stops at the budget', () => {
    const merged = interleave([[doc('help', 'H1'), doc('help', 'H2'), doc('help', 'H3')]], 2)
    assert.equal(merged.length, 2)
  })

  it('keeps going when a source returned nothing', () => {
    const merged = interleave([[], [doc('developer', 'D1')], []], 6)
    assert.deepEqual(merged.map((d) => d.title), ['D1'])
  })

  it('collapses a page one source listed twice', () => {
    const merged = interleave([[doc('help', 'Backstory MCP')], [], [], [doc('help', 'backstory mcp ')]], 6)
    assert.equal(merged.length, 1)
  })

  it('keeps same-titled pages from different sources — they are different pages', () => {
    const merged = interleave([[doc('help', 'MCP')], [doc('developer', 'MCP')], []], 6)
    assert.equal(merged.length, 2)
  })

  it('returns nothing when no source matched', () => {
    assert.deepEqual(interleave([[], [], []]), [])
  })
})

describe('SOURCE_LABEL', () => {
  it('names every source in the words a citation shows', () => {
    assert.deepEqual(Object.keys(SOURCE_LABEL).sort(), ['developer', 'help', 'library'])
    for (const label of Object.values(SOURCE_LABEL)) assert.ok(label.startsWith('Backstory'))
  })
})
