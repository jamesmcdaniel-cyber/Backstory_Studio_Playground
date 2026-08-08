import test from 'node:test'
import assert from 'node:assert/strict'
import { readRequestTextLimited, RequestBodyTooLargeError } from '../request-body'

test('bounded request reader accepts a body within the ceiling', async () => {
  const request = new Request('https://app.test/hook', { method: 'POST', body: 'hello' })
  assert.equal(await readRequestTextLimited(request, 5), 'hello')
})

test('bounded request reader rejects declared and streamed oversize bodies', async () => {
  const declared = new Request('https://app.test/hook', {
    method: 'POST', body: 'x', headers: { 'content-length': '100' },
  })
  await assert.rejects(readRequestTextLimited(declared, 10), RequestBodyTooLargeError)

  const streamed = new Request('https://app.test/hook', { method: 'POST', body: '01234567890' })
  await assert.rejects(readRequestTextLimited(streamed, 10), RequestBodyTooLargeError)
})
