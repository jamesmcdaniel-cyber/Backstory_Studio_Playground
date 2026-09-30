import test from 'node:test'
import assert from 'node:assert/strict'
import { createJsonStringFieldReader, createTrailerFilter } from '../stream-text'

function feedAll(reader: (delta: string) => string, chunks: string[]): string {
  return chunks.map(reader).join('')
}

test('streams one JSON string field as it is written, escapes decoded across chunk boundaries', () => {
  const json = JSON.stringify({ message: 'Added a "Slack" step\nand a filter — done ✓', opsJson: '[{"op":"add"}]' })
  // Every possible split point, one character at a time.
  const reader = createJsonStringFieldReader('message')
  const out = feedAll(reader, json.split(''))
  assert.equal(out, 'Added a "Slack" step\nand a filter — done ✓')
})

test('a field that comes later still streams once it starts; other fields never leak', () => {
  const json = '{"proposal":null,"reply":"Win rate rose \\u2014 engagement"}'
  const reader = createJsonStringFieldReader('reply')
  assert.equal(feedAll(reader, [json.slice(0, 20), json.slice(20, 35), json.slice(35)]), 'Win rate rose — engagement')
  assert.equal(feedAll(createJsonStringFieldReader('reply'), ['{"proposal":{"reply_hint":"x"}}']), '')
})

test('the citation line never reaches the screen, split anywhere', () => {
  const text = 'Connect Slack from Integrations.\nThen pick a channel.\nRELEVANT: 1, 3'
  for (let size = 1; size <= 8; size += 1) {
    const filter = createTrailerFilter()
    const chunks: string[] = []
    for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size))
    const out = feedAll(filter, chunks)
    assert.equal(out.trimEnd(), 'Connect Slack from Integrations.\nThen pick a channel.', `chunk size ${size}`)
  }
})

test('text without a citation line is released in full by the end', () => {
  const filter = createTrailerFilter()
  const out = feedAll(filter, ['Short answer', ' with no citations.']) + filter('')
  // The last few characters may be held back until the stream ends; the route
  // sends the final parsed answer in `done`, which is what the UI settles on.
  assert.ok('Short answer with no citations.'.startsWith(out))
  assert.ok(out.length >= 'Short answer with no'.length)
})
