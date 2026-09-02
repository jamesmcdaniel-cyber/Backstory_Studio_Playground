import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderRepositoryManifest, MANIFEST_MAX_ENTRIES, MANIFEST_MAX_CHARS } from '../manifest'

const entry = (filename: string, description = 'stage map') => ({ filename, description, collection: 'Customer Journey' })

test('no documents produces no block at all', () => {
  assert.equal(renderRepositoryManifest([]), '')
})

test('the manifest names documents and points at the tools', () => {
  const block = renderRepositoryManifest([entry('FY26 Customer Journey.pdf')])
  assert.ok(block.includes('FY26 Customer Journey.pdf'))
  assert.ok(block.includes('stage map'))
  assert.ok(block.includes('Customer Journey'))
  assert.ok(block.includes('repository_search'))
  assert.ok(block.includes('repository_read'))
})

test('it never carries passage text — only titles and descriptions', () => {
  const block = renderRepositoryManifest([entry('a.md')])
  assert.equal(block.includes('From "'), false)
})

test('it caps the entry count and says how many were left out', () => {
  const many = Array.from({ length: MANIFEST_MAX_ENTRIES + 10 }, (_, i) => entry(`doc-${i}.md`, ''))
  const block = renderRepositoryManifest(many)
  assert.ok(block.includes('10 more'))
  assert.ok(block.includes('repository_list'))
})

test('it stays within the character budget even with maximal descriptions', () => {
  const many = Array.from({ length: MANIFEST_MAX_ENTRIES }, (_, i) => entry(`doc-${i}.md`, 'x'.repeat(400)))
  assert.ok(renderRepositoryManifest(many).length <= MANIFEST_MAX_CHARS + 300)
})
