import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeReturnToPath } from '../oauth-authcode'

test('safeReturnToPath accepts plain same-origin paths', () => {
  assert.equal(safeReturnToPath('/connect'), '/connect')
  assert.equal(safeReturnToPath('/connections?connected=1'), '/connections?connected=1')
})

test('safeReturnToPath rejects protocol-relative, backslash, and absolute URLs', () => {
  assert.equal(safeReturnToPath('//evil.com'), undefined)
  assert.equal(safeReturnToPath('/\\evil.com'), undefined)
  assert.equal(safeReturnToPath('\\/evil.com'), undefined)
  assert.equal(safeReturnToPath('https://evil.com'), undefined)
  assert.equal(safeReturnToPath(''), undefined)
  assert.equal(safeReturnToPath(undefined), undefined)
})

test('safeReturnToPath rejects backslashes anywhere in the path', () => {
  assert.equal(safeReturnToPath('/connect\\..'), undefined)
})

test('safeReturnToPath rejects control characters (WHATWG strips them before parsing)', () => {
  assert.equal(safeReturnToPath('/\t/evil.com'), undefined)
  assert.equal(safeReturnToPath('/\n/evil.com'), undefined)
  assert.equal(safeReturnToPath('/\r/evil.com'), undefined)
  assert.equal(safeReturnToPath('/connect '), undefined)
})
