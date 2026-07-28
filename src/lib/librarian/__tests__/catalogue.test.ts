import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { searchBuiltinCatalogue, termMatches } from '@/lib/librarian/catalogue'

describe('termMatches', () => {
  it('matches a plural query term against a singular title', () => {
    assert.equal(termMatches('briefs', 'meeting brief'), true)
    assert.equal(termMatches('agents', 'agent template'), true)
  })

  it('does not strip an "s" off a short word, where it is usually part of the word', () => {
    assert.equal(termMatches('mcp', 'backstory mcp'), true)
    assert.equal(termMatches('cts', 'ct something'), false)
  })

  it('does not match unrelated words', () => {
    assert.equal(termMatches('tokyo', 'meeting brief · daily intelligence'), false)
  })
})

describe('searchBuiltinCatalogue', () => {
  /**
   * The regression this exists for: asked "which template generates meeting
   * briefs?", the Assistant answered that it had no information about one —
   * because it searched only stored rows, and the whole shipped gallery lives
   * in code.
   */
  it('finds the Meeting Brief template, ranked first, for the question that used to fail', () => {
    const hits = searchBuiltinCatalogue(['template', 'generates', 'meeting', 'briefs'])
    assert.equal(hits[0]?.title, 'Meeting Brief', `expected Meeting Brief first, got ${hits.map((h) => h.title).join(', ')}`)
    assert.equal(hits[0]?.href, '/templates/02-meeting-brief')
    assert.equal(hits[0]?.subtitle, 'Agent template · Daily Intelligence')
  })

  it('searches flow templates as well as agent templates', () => {
    const hits = searchBuiltinCatalogue(['churn', 'risk'])
    assert.ok(hits.some((h) => h.href === '/templates/07-churn-risk-scorecard'), 'expected the churn agent template')
    assert.ok(hits.some((h) => h.href === '/flow-templates/churn-risk-scorecard'), 'expected the churn flow template')
  })

  it('links each kind at the detail route that can actually open it', () => {
    for (const hit of searchBuiltinCatalogue(['pipeline'])) {
      const expected = hit.type === 'flow' ? '/flow-templates/' : '/templates/'
      assert.ok(hit.href.startsWith(expected), `${hit.title} (${hit.type}) links to ${hit.href}`)
    }
  })

  it('ranks by how many query terms hit, so the closest template leads', () => {
    const hits = searchBuiltinCatalogue(['upsell', 'account', 'scorer'])
    assert.equal(hits[0]?.title, 'Upsell Account Scorer')
  })

  it('returns nothing for an off-topic question rather than padding the answer', () => {
    assert.deepEqual(searchBuiltinCatalogue(['weather', 'tokyo']), [])
    assert.deepEqual(searchBuiltinCatalogue([]), [])
  })

  it('caps what it returns so the catalogue cannot crowd out the workspace', () => {
    assert.ok(searchBuiltinCatalogue(['agent', 'template'], 6).length <= 6)
    assert.ok(searchBuiltinCatalogue(['agent', 'template'], 2).length <= 2)
  })
})
