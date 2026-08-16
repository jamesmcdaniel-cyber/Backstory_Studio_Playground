import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseN8nInstanceUrl } from '../n8n-instance'

/**
 * The parser decides which URLs trigger a CREDENTIALED fetch, so its rejects
 * matter as much as its accepts: a URL it wrongly recognizes would have the
 * instance's API key attached to a request the author never intended.
 */

test('recognizes an n8n cloud editor URL and derives the API endpoint', () => {
  const ref = parseN8nInstanceUrl('https://backstoryai.app.n8n.cloud/workflow/IBsXYLHRJSBZj6NM')

  assert.ok(ref)
  assert.equal(ref.host, 'backstoryai.app.n8n.cloud')
  assert.equal(ref.workflowId, 'IBsXYLHRJSBZj6NM')
  assert.equal(ref.apiUrl, 'https://backstoryai.app.n8n.cloud/api/v1/workflows/IBsXYLHRJSBZj6NM')
})

test('self-hosted instances work the same — the shape is the signal, not the domain', () => {
  const ref = parseN8nInstanceUrl('https://n8n.internal-tools.example.com/workflow/abc123XYZ_-4')
  assert.ok(ref)
  assert.equal(ref.host, 'n8n.internal-tools.example.com')
})

test('a trailing slash is tolerated; extra path segments are not', () => {
  assert.ok(parseN8nInstanceUrl('https://x.app.n8n.cloud/workflow/IBsXYLHRJSBZj6NM/'))
  // /workflow/<id>/executions is a different page; attaching the key to a
  // derived URL from it would be a guess, and guesses do not get credentials.
  assert.equal(parseN8nInstanceUrl('https://x.app.n8n.cloud/workflow/IBsXYLHRJSBZj6NM/executions'), null)
})

test('the n8n.io gallery is NEVER treated as an instance', () => {
  // Plural /workflows/ is the public gallery, handled by resolveN8nImportUrl
  // without any credential. Misclassifying it would attach a stored key to a
  // request to n8n.io.
  assert.equal(parseN8nInstanceUrl('https://n8n.io/workflows/2861'), null)
  assert.equal(parseN8nInstanceUrl('https://www.n8n.io/workflows/2861-some-slug/'), null)
  // And even the singular path on n8n.io stays out.
  assert.equal(parseN8nInstanceUrl('https://n8n.io/workflow/IBsXYLHRJSBZj6NM'), null)
})

test('http is refused — the API key must never travel unencrypted', () => {
  assert.equal(parseN8nInstanceUrl('http://n8n.example.com/workflow/IBsXYLHRJSBZj6NM'), null)
})

test('ids outside the nanoid alphabet are not editor URLs', () => {
  assert.equal(parseN8nInstanceUrl('https://x.app.n8n.cloud/workflow/'), null)
  assert.equal(parseN8nInstanceUrl('https://x.app.n8n.cloud/workflow/has%20spaces'), null)
  assert.equal(parseN8nInstanceUrl('https://x.app.n8n.cloud/workflow/short'), null)
})

test('the API URL is rebuilt from parsed parts, never from string surgery', () => {
  // A crafted path must not smuggle segments into the credentialed request.
  const ref = parseN8nInstanceUrl('https://x.app.n8n.cloud/workflow/AAAABBBBCCCC?evil=../../admin')
  assert.ok(ref)
  assert.equal(ref.apiUrl, 'https://x.app.n8n.cloud/api/v1/workflows/AAAABBBBCCCC')
})

test('garbage never throws', () => {
  assert.equal(parseN8nInstanceUrl('not a url'), null)
  assert.equal(parseN8nInstanceUrl(''), null)
})
