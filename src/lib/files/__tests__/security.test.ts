import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertNotExecutable, detectFileMime, FileRejectedError, scanFileBuffer, verifyFileMime } from '../security'

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

test('executables are rejected by signature, whatever they are named', () => {
  for (const head of [[0x4d, 0x5a, 0x90, 0x00], [0x7f, 0x45, 0x4c, 0x46, 0x02], [0xcf, 0xfa, 0xed, 0xfe, 0x07]]) {
    assert.throws(() => assertNotExecutable(Buffer.from(head)), FileRejectedError)
  }
  assert.doesNotThrow(() => assertNotExecutable(Buffer.from('<!DOCTYPE html><html></html>')))
  assert.doesNotThrow(() => assertNotExecutable(Buffer.from('MONTH,EMAIL\n2026-01,a@b.com\n')), 'text that merely starts with "M" is not a PE header')
})

test('with no scanner configured, uploads pass the built-in checks — production included', async () => {
  const saved = { url: process.env.FILE_SCAN_URL, required: process.env.FILE_SCAN_REQUIRED, env: process.env.NODE_ENV }
  delete process.env.FILE_SCAN_URL
  delete process.env.FILE_SCAN_REQUIRED
  ;(process.env as Record<string, string>).NODE_ENV = 'production'
  try {
    await scanFileBuffer(Buffer.from('<html><body>cockpit</body></html>'), 'cockpit.html')
    await assert.rejects(scanFileBuffer(Buffer.from([0x4d, 0x5a, 0x90, 0x00]), 'invoice.pdf'), FileRejectedError)
    process.env.FILE_SCAN_REQUIRED = 'true'
    await assert.rejects(scanFileBuffer(Buffer.from('hello'), 'note.txt'), (error: unknown) => error instanceof FileRejectedError && /no scanner is configured/.test(error.message))
  } finally {
    if (saved.url === undefined) delete process.env.FILE_SCAN_URL; else process.env.FILE_SCAN_URL = saved.url
    if (saved.required === undefined) delete process.env.FILE_SCAN_REQUIRED; else process.env.FILE_SCAN_REQUIRED = saved.required
    ;(process.env as Record<string, string | undefined>).NODE_ENV = saved.env
  }
})
