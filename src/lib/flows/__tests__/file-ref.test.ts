import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileReference, isFileReference } from '../file-ref'

test('fileReference builds a token-friendly reference with a download URL', () => {
  const ref = fileReference(
    { id: 'file_1', filename: 'report.csv', mimeType: 'text/csv', size: 42 },
    { content: 'a,b\n1,2', baseUrl: 'https://app.example.com' },
  )
  assert.deepEqual(ref, {
    fileId: 'file_1',
    filename: 'report.csv',
    mimeType: 'text/csv',
    size: 42,
    url: 'https://app.example.com/api/files/file_1',
    content: 'a,b\n1,2',
  })
})

test('fileReference omits content when none was extracted', () => {
  const ref = fileReference({ id: 'f', filename: 'x.png', mimeType: 'image/png', size: 10 }, { baseUrl: '' })
  assert.equal(ref.content, undefined)
  assert.equal(ref.url, '/api/files/f')
})

test('isFileReference recognizes a reference by its fileId', () => {
  assert.equal(isFileReference({ fileId: 'f', filename: 'x', mimeType: 'text/plain', size: 1, url: '/api/files/f' }), true)
  assert.equal(isFileReference({ name: 'not a file' }), false)
  assert.equal(isFileReference('string'), false)
  assert.equal(isFileReference(null), false)
})
