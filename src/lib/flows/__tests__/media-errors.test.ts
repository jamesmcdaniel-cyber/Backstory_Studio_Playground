import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeMediaError } from '../media-errors'

const named = (name: string) => Object.assign(new Error(name), { name })

test('a denied mic is not retryable and points at the browser control', () => {
  const info = describeMediaError(named('NotAllowedError'))
  assert.equal(info.retryable, false)
  assert.match(info.title, /blocked/i)
  assert.match(info.hint, /address bar/i)
})

test('a missing or busy device is retryable', () => {
  for (const name of ['NotFoundError', 'OverconstrainedError', 'NotReadableError']) {
    assert.equal(describeMediaError(named(name)).retryable, true, name)
  }
  assert.match(describeMediaError(named('NotFoundError')).title, /no microphone/i)
  assert.match(describeMediaError(named('NotReadableError')).title, /in use/i)
})

test('unknown and non-error values fall back to a generic retryable message', () => {
  for (const value of [named('WeirdError'), undefined, null, 'a string', {}]) {
    const info = describeMediaError(value)
    assert.equal(info.retryable, true)
    assert.ok(info.title.length > 0 && info.hint.length > 0)
  }
})

test('no message uses raw token syntax', () => {
  for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'Whatever']) {
    const info = describeMediaError(named(name))
    assert.ok(!/\{\{|\}\}/.test(`${info.title} ${info.hint}`), name)
  }
})
