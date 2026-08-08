import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalAppOrigin } from '../app-origin'

test('configured canonical origin wins over an attacker-controlled request host', () => {
  const previous = process.env.NEXT_PUBLIC_APP_URL
  process.env.NEXT_PUBLIC_APP_URL = 'https://studio.example.com/path'
  try {
    assert.equal(canonicalAppOrigin('https://evil.example/callback'), 'https://studio.example.com')
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_APP_URL
    else process.env.NEXT_PUBLIC_APP_URL = previous
  }
})
