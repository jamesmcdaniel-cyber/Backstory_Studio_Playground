import { test } from 'node:test'
import assert from 'node:assert/strict'
import { brandDomain, brandSlug, logoSources } from '../brand-logo-sources'

test('brandSlug strips the auth-method qualifiers Nango appends', () => {
  assert.equal(brandSlug('gong-oauth'), 'gong')
  assert.equal(brandSlug('github-user-oauth'), 'github')
  assert.equal(brandSlug('apollo-api-key'), 'apollo')
  assert.equal(brandSlug('salesforce-sandbox'), 'salesforce')
  // A brand whose own name isn't a qualifier is left alone.
  assert.equal(brandSlug('google-calendar'), 'google-calendar')
})

test('brandDomain maps non-.com brands and parents product keys', () => {
  assert.equal(brandDomain('gong'), 'gong.io')
  assert.equal(brandDomain('clari-copilot'), 'clari.com')
  // Unmapped brands guess <brand>.com; the favicon 404s if that isn't real.
  assert.equal(brandDomain('zendesk'), 'zendesk.com')
  // A product key falls back to its parent brand, not "google-calendar.com".
  assert.equal(brandDomain('google-calendar'), 'google.com')
})

test('logoSources always offers a real logo before the initial tile', () => {
  // Hyphenated product keys reach the right Simple Icons slug.
  assert.deepEqual(logoSources({ slug: 'google-calendar' })[0], 'https://cdn.simpleicons.org/googlecalendar')
  // Brands Simple Icons doesn't carry still end on their own favicon.
  assert.deepEqual(logoSources({ slug: 'gong-oauth' }).at(-1), 'https://icons.duckduckgo.com/ip3/gong.io.ico')
  // A bundled asset outranks the catalogue's URL and both CDNs.
  assert.equal(logoSources({ slug: 'salesforce', src: 'https://app.nango.dev/x.svg' })[0], '/logos/salesforce.svg')
  // Every custom Backstory MCP connection gets our own mark.
  assert.equal(logoSources({ slug: 'backstory_mcp' })[0], '/backstory-symbol-black.png')
  // Nothing to go on: the caller renders the initial tile.
  assert.deepEqual(logoSources({ slug: null }), [])
})
