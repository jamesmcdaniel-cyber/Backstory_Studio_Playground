import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeInlineImageSource } from '../markdown'

test('markdown only auto-loads non-network image sources', () => {
  assert.equal(safeInlineImageSource('/images/report.png'), true)
  assert.equal(safeInlineImageSource('data:image/png;base64,AA=='), true)
  assert.equal(safeInlineImageSource('blob:https://app.example/id'), true)
  assert.equal(safeInlineImageSource('https://attacker.example/leak?secret=value'), false)
  assert.equal(safeInlineImageSource('//attacker.example/leak'), false)
})
