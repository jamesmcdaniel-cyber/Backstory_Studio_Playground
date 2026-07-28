import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseDocIndex, rankDocIndex, stripIndexPreamble, type DevDocEntry } from '@/lib/help-center/dev-docs'
import { questionTerms } from '@/lib/help-center/fetching'

// Shaped exactly like the live https://backstory-studio.mintlify.site/llms.txt:
// a heading, a blockquote, then one list item per page — some with a trailing
// description, some without — and the OpenAPI specs in their own section.
const INDEX = `# Backstory

> Developer documentation for the Backstory API.

## Docs

- [List accounts](https://backstory-studio.mintlify.app/api-reference/accounts/list-accounts.md): Return all accounts for your organization.
- [Get account by ID](https://backstory-studio.mintlify.app/api-reference/accounts/get-account-by-id.md)
- [MCP](https://backstory-studio.mintlify.app/essentials/mcp.md): Connect an agent to the Backstory MCP server.
- [Your first agent over MCP](https://backstory-studio.mintlify.app/recipes/first-agent-over-mcp.md): Connect an agent to the Backstory MCP and get from a company name to a strategic account answer.

## OpenAPI Specs

- [openapi](https://backstory-studio.mintlify.app/api-reference/openapi.yaml)
`

describe('parseDocIndex', () => {
  const entries = parseDocIndex(INDEX)

  it('reads every documented page, with its description when it has one', () => {
    assert.equal(entries.length, 4)
    assert.equal(entries[0].title, 'List accounts')
    assert.equal(entries[0].description, 'Return all accounts for your organization.')
    assert.equal(entries[1].description, '')
  })

  it('links the page a reader can open, and keeps the .md twin for fetching', () => {
    const mcp = entries.find((e) => e.title === 'MCP')
    assert.ok(mcp)
    assert.equal(mcp.url, 'https://backstory-studio.mintlify.site/essentials/mcp')
    assert.equal(mcp.markdownUrl, 'https://backstory-studio.mintlify.site/essentials/mcp.md')
  })

  it('skips the OpenAPI specs — megabytes of YAML that answer nothing a page does not', () => {
    assert.ok(!entries.some((e) => e.url.includes('openapi')))
  })

  it('keeps one entry per page when the index lists a page twice', () => {
    const twice = parseDocIndex(`${INDEX}\n- [MCP again](https://backstory-studio.mintlify.app/essentials/mcp.md)`)
    assert.equal(twice.filter((e) => e.url.endsWith('/essentials/mcp')).length, 1)
  })

  it('returns nothing for a page with no list items', () => {
    assert.deepEqual(parseDocIndex('# Backstory\n\nNothing here.'), [])
  })
})

describe('stripIndexPreamble', () => {
  it('drops the crawler preamble Mintlify prepends to every raw page', () => {
    const page = stripIndexPreamble([
      '> ## Documentation Index',
      '> Fetch the complete documentation index at: https://backstory-studio.mintlify.site/llms.txt',
      '> Use this file to discover all available pages before exploring further.',
      '',
      '# Your first agent over MCP',
      '',
      'The server is at `https://mcp.backstory.ai/mcp`.',
    ].join('\n'))
    assert.ok(page.startsWith('# Your first agent over MCP'))
    assert.ok(!page.includes('llms.txt'))
  })

  it('leaves a page that genuinely opens on a blockquote alone', () => {
    const page = stripIndexPreamble('> Deprecated in v0.\n\n# List accounts')
    assert.ok(page.startsWith('> Deprecated in v0.'))
  })
})

describe('rankDocIndex', () => {
  const entries = parseDocIndex(INDEX)

  it('puts the page whose title carries the question first', () => {
    const ranked = rankDocIndex(questionTerms('What can I do with Backstory MCP?'), entries, 2)
    assert.equal(ranked[0].title, 'MCP')
  })

  it('ranks nothing when the docs share no vocabulary with the question', () => {
    assert.deepEqual(rankDocIndex(questionTerms('what is the weather in Tokyo'), entries), [])
  })

  it('ranks nothing for a question with no matchable words', () => {
    assert.deepEqual(rankDocIndex(questionTerms('how do you do that?'), entries), [])
  })

  it('honours the depth limit', () => {
    const ranked = rankDocIndex(questionTerms('backstory account'), entries, 1)
    assert.equal(ranked.length, 1)
  })

  it('matches a plural in the question against the singular in the docs', () => {
    const entry: DevDocEntry = {
      title: 'Account',
      url: 'https://backstory-studio.mintlify.site/x',
      markdownUrl: 'https://backstory-studio.mintlify.site/x.md',
      description: '',
    }
    assert.equal(rankDocIndex(['accounts'], [entry]).length, 1)
  })
})
