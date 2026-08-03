import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectFileMime, verifyFileMime } from '../security'

test('file MIME detection trusts magic bytes over browser labels', () => {
  assert.equal(detectFileMime(Buffer.from('%PDF-1.7\n'), 'application/octet-stream', 'report.bin'), 'application/pdf')
  assert.equal(detectFileMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'text/plain', 'x.txt'), 'image/png')
  assert.equal(detectFileMime(Buffer.from('hello'), 'text/plain; charset=utf-8', 'note.txt'), 'text/plain')
})

test('fake PDFs are rejected instead of reaching the parser', () => {
  assert.throws(() => verifyFileMime(Buffer.from('not a pdf'), 'application/pdf', 'report.pdf'), /not a valid PDF/)
})

test('unknown binary content is stored as octet-stream', () => {
  assert.equal(detectFileMime(Buffer.from([0, 1, 2, 3]), 'text/plain', 'payload.txt'), 'application/octet-stream')
})
