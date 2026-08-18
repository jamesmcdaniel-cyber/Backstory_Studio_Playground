import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSupported, extractText, chunkText } from '../extract'

test('isSupported accepts text formats and PDFs, rejects other binaries', () => {
  assert.equal(isSupported('text/plain', 'notes.txt'), true)
  assert.equal(isSupported('application/json', 'data.json'), true)
  assert.equal(isSupported('', 'README.md'), true)
  assert.equal(isSupported('application/pdf', 'doc.pdf'), true)
  assert.equal(isSupported('', 'report.PDF'), true)
  assert.equal(isSupported('image/png', 'logo.png'), false)
  // DOCX extraction lives in ./docx and is covered by docx.test.ts.
  assert.equal(isSupported('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'doc.docx'), true)
})

test('extractText decodes text and strips HTML markup', () => {
  assert.equal(extractText(Buffer.from('Hello\r\nworld'), 'text/plain', 'a.txt'), 'Hello\nworld')
  assert.equal(
    extractText(Buffer.from('<p>Hi <b>there</b></p><script>bad()</script>'), 'text/html', 'a.html').replace(/\s+/g, ' ').trim(),
    'Hi there',
  )
})

test('chunkText returns one chunk for short text, many for long', () => {
  assert.deepEqual(chunkText('short'), ['short'])
  assert.deepEqual(chunkText(''), [])
  const long = 'para. '.repeat(600) // ~3600 chars
  const chunks = chunkText(long, { size: 1200, overlap: 150 })
  assert.ok(chunks.length >= 3)
  assert.ok(chunks.every((c) => c.length <= 1200))
})
