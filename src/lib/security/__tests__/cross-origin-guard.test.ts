import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rejectsCrossOriginWrite } from '../cross-origin-guard'

const OUR = 'https://backstory-studio.vercel.app'

test('reads are never rejected, whatever their origin', () => {
  assert.equal(rejectsCrossOriginWrite('GET', 'https://evil.example', OUR), false)
  assert.equal(rejectsCrossOriginWrite('HEAD', 'https://evil.example', OUR), false)
  assert.equal(rejectsCrossOriginWrite('OPTIONS', 'https://evil.example', OUR), false)
})

test('a same-origin write passes', () => {
  assert.equal(rejectsCrossOriginWrite('POST', OUR, OUR), false)
})

test('a cross-origin browser write is rejected', () => {
  assert.equal(rejectsCrossOriginWrite('POST', 'https://evil.example', OUR), true)
  assert.equal(rejectsCrossOriginWrite('DELETE', 'https://evil.example', OUR), true)
  assert.equal(rejectsCrossOriginWrite('PATCH', 'https://evil.example', OUR), true)
  assert.equal(rejectsCrossOriginWrite('PUT', 'https://evil.example', OUR), true)
})

test('an opaque origin is rejected — a sandboxed page is not a caller we know', () => {
  assert.equal(rejectsCrossOriginWrite('POST', 'null', OUR), true)
})

test('no Origin header passes — servers, webhooks and CLI clients do not send one', () => {
  assert.equal(rejectsCrossOriginWrite('POST', null, OUR), false)
  assert.equal(rejectsCrossOriginWrite('POST', undefined, OUR), false)
})

test('origins compare exactly — a prefix or subdomain is still cross-origin', () => {
  assert.equal(rejectsCrossOriginWrite('POST', 'https://backstory-studio.vercel.app.evil.example', OUR), true)
  assert.equal(rejectsCrossOriginWrite('POST', 'https://sub.backstory-studio.vercel.app', OUR), true)
})
