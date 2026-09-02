import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REPOSITORY_TOOLS, repositoryToolIsWrite } from '../tools'

test('the repository exposes exactly search, read and list', () => {
  assert.deepEqual(
    REPOSITORY_TOOLS.map((tool) => tool.name).sort(),
    ['repository_list', 'repository_read', 'repository_search'],
  )
})

test('every repository tool is read-only', () => {
  for (const tool of REPOSITORY_TOOLS) {
    assert.equal(tool.isWrite, false, `${tool.name} must be read-only`)
    assert.equal(repositoryToolIsWrite(tool.name), false)
  }
})

test('an unknown tool is treated as a write, never as a safe read', () => {
  assert.equal(repositoryToolIsWrite('repository_delete_everything'), true)
})

test('every tool declares an object input schema and describes itself', () => {
  for (const tool of REPOSITORY_TOOLS) {
    assert.equal(tool.inputSchema.type, 'object')
    assert.ok(tool.description.length > 30, `${tool.name} needs a usable description`)
  }
})

test('repository_search requires a query and repository_read requires a documentId', () => {
  const search = REPOSITORY_TOOLS.find((tool) => tool.name === 'repository_search')!
  assert.deepEqual(search.inputSchema.required, ['query'])
  const read = REPOSITORY_TOOLS.find((tool) => tool.name === 'repository_read')!
  assert.deepEqual(read.inputSchema.required, ['documentId'])
})

// ── extractCitedDocuments ────────────────────────────────────────────────────

import { extractCitedDocuments } from '../tools'

test('a search result yields every cited document once per passage source', () => {
  const cited = extractCitedDocuments({
    passages: [
      { documentId: 'd1', filename: 'journey.md', text: 'x' },
      { documentId: 'd1', filename: 'journey.md', text: 'y' },
      { documentId: 'd2', filename: 'playbook.md', text: 'z' },
    ],
  })
  assert.deepEqual(cited, [
    { id: 'd1', filename: 'journey.md' },
    { id: 'd2', filename: 'playbook.md' },
  ])
})

test('a read result yields its single document', () => {
  assert.deepEqual(
    extractCitedDocuments({ documentId: 'd1', filename: 'journey.md', text: '…' }),
    [{ id: 'd1', filename: 'journey.md' }],
  )
})

test('a malformed result yields nothing rather than throwing', () => {
  assert.deepEqual(extractCitedDocuments(null), [])
  assert.deepEqual(extractCitedDocuments('oops'), [])
  assert.deepEqual(extractCitedDocuments({ passages: 'not-an-array' }), [])
  assert.deepEqual(extractCitedDocuments({ passages: [{ text: 'no ids' }] }), [])
})
