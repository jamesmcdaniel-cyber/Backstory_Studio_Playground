import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readResponseBytesLimited, readResponseTextLimited } from '../response-body'

test('bounded response readers return content within the limit', async () => {
  assert.equal(await readResponseTextLimited(new Response('hello'), 5), 'hello')
  assert.deepEqual(
    [...await readResponseBytesLimited(new Response(new Uint8Array([1, 2, 3])), 3)],
    [1, 2, 3],
  )
})

test('bounded response readers reject declared and streamed oversized bodies', async () => {
  await assert.rejects(
    () => readResponseTextLimited(new Response('short', { headers: { 'content-length': '100' } }), 10),
    /exceeded 10 bytes/,
  )

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(8))
      controller.enqueue(new Uint8Array(8))
      controller.close()
    },
  })
  await assert.rejects(() => readResponseBytesLimited(new Response(stream), 10), /exceeded 10 bytes/)
})
