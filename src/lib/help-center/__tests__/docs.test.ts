import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decodeEntities, extractArticleText, parseSearchResults } from '@/lib/help-center/docs'

/**
 * Fixtures mirror what help.backstory.ai actually serves (Intercom): search
 * cards whose matched words are split into their own <span>s for highlighting,
 * and an article bounded by the reaction footer.
 */
const SEARCH_HTML = `
<div class="w-full" role="listitem"><a class="collection-link group/search-card" href="/en/articles/15252736-backstory-mcp"><div class="p-5"><div class="article__preview intercom-force-break"><div class="t__h3"><span class="text-md font-semibold"><span class="">Backstory </span><span class="font-bold">MCP</span></span></div><span class="paper__preview text-body-secondary-color"><span class="">Ask Questions Using </span><span class="font-bold">MCP</span><span class=""> Tools&hellip; What is </span><span class="font-bold">MCP</span><span class="">?</span></span></div></div></a></div>
<div class="w-full" role="listitem"><a class="collection-link" href="/en/articles/15252710-connect-claude-to-backstory"><div class="p-5"><div class="t__h3"><span>Connect Claude to Backstory</span></div><span class="paper__preview"><span>Use the </span><span class="font-bold">MCP</span><span> integration</span></span></div></a></div>
<a class="nav" href="/en/collections/19658946-mcp">MCP collection</a>
<div role="listitem"><a class="collection-link" href="/en/articles/15252736-backstory-mcp"><div class="t__h3"><span>Backstory MCP</span></div></a></div>
`

const ARTICLE_HTML = `
<html><head><style>.x{color:red}</style><script>window.x=1</script></head><body>
<nav><ol><li>Help Center</li><li aria-current="page">Backstory MCP</li></ol></nav>
<div class="article intercom-force-break">
  <h1>Backstory MCP</h1>
  <p>Connect AI clients to your live Backstory data.</p>
  <time>Updated over a week ago</time>
  <p>Table of contents</p>
  <p>Backstory MCP is a secure connection that lets AI assistants access your data using the Model&nbsp;Context Protocol.</p>
  <ul><li>Claude</li><li>ChatGPT</li></ul>
  <p>Because access uses OAuth, the assistant can only reach data you can already see.</p>
</div>
<div class="reaction">Did this answer your question?</div>
<footer><p>Backstory 2026 &copy;</p><a href="/en/">Other articles you should definitely read</a></footer>
</body></html>
`

describe('parseSearchResults', () => {
  const results = parseSearchResults(SEARCH_HTML)

  it('reads the title and preview back out of the highlight spans', () => {
    assert.equal(results[0].title, 'Backstory MCP')
    assert.equal(results[0].url, 'https://help.backstory.ai/en/articles/15252736-backstory-mcp')
    assert.ok(results[0].snippet.startsWith('Ask Questions Using MCP Tools… What is MCP?'), results[0].snippet)
  })

  it('keeps every distinct article, in page order', () => {
    assert.deepEqual(results.map((r) => r.title), ['Backstory MCP', 'Connect Claude to Backstory'])
  })

  it('ignores collection links and repeated cards for the same article', () => {
    assert.equal(results.length, 2, 'the collection link and the duplicate card must not appear')
    assert.ok(!results.some((r) => r.url.includes('/collections/')))
  })

  it('returns nothing for a page with no article cards', () => {
    assert.deepEqual(parseSearchResults('<div>No results found</div>'), [])
  })
})

describe('extractArticleText', () => {
  const text = extractArticleText(ARTICLE_HTML)

  it('keeps the article body, with list items on their own lines', () => {
    assert.ok(text.startsWith('Backstory MCP'), text.slice(0, 60))
    assert.ok(text.includes('Model Context Protocol'), 'entities should be decoded')
    assert.ok(text.includes('• Claude'), 'list items should survive as lines')
    assert.ok(text.includes('OAuth'))
  })

  it('stops at the reaction footer, so page furniture never reaches the model', () => {
    assert.ok(!text.includes('Did this answer'), text.slice(-120))
    assert.ok(!text.includes('Other articles'), 'footer navigation must be cut')
    assert.ok(!text.includes('window.x') && !text.includes('color:red'), 'scripts and styles must be stripped')
  })

  it('drops the byline and in-page nav that carry no answer', () => {
    assert.ok(!/Updated over a week ago/.test(text))
    assert.ok(!/^Table of contents$/m.test(text))
  })

  it('degrades to whole-page text rather than nothing when the markers are missing', () => {
    const text = extractArticleText('<html><body><p>Just a paragraph.</p></body></html>')
    assert.equal(text, 'Just a paragraph.')
  })
})

describe('decodeEntities', () => {
  it('decodes named, decimal, and hex references', () => {
    assert.equal(decodeEntities('a &amp; b &#8212; c &#x2026;'), 'a & b — c …')
  })

  it('leaves unknown references alone rather than mangling them', () => {
    assert.equal(decodeEntities('&notanentity; stays'), '&notanentity; stays')
  })
})
