import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPttTrigger, micEnabled, PTT_KEY } from '../push-to-talk'

test('space on the page triggers; other keys do not', () => {
  assert.equal(isPttTrigger(PTT_KEY, { tagName: 'DIV' }, false), true)
  assert.equal(isPttTrigger('a', { tagName: 'DIV' }, false), false)
  assert.equal(isPttTrigger('Enter', { tagName: 'DIV' }, false), false)
})

test('auto-repeat never re-triggers', () => {
  assert.equal(isPttTrigger(PTT_KEY, { tagName: 'DIV' }, true), false)
})

test('typing a space in an editor never opens the mic', () => {
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    assert.equal(isPttTrigger(PTT_KEY, { tagName }, false), false, tagName)
  }
  // CodeMirror renders contentEditable, not a textarea.
  assert.equal(isPttTrigger(PTT_KEY, { tagName: 'DIV', isContentEditable: true }, false), false)
})

test('a null target is treated as the page', () => {
  assert.equal(isPttTrigger(PTT_KEY, null, false), true)
})

test('with PTT off, the mute button decides', () => {
  assert.equal(micEnabled(false, false, false), true)
  assert.equal(micEnabled(true, false, false), false)
  // Holding space with the mode off changes nothing.
  assert.equal(micEnabled(true, false, true), false)
})

test('with PTT on, only holding the key transmits — mute is ignored', () => {
  assert.equal(micEnabled(false, true, false), false)
  assert.equal(micEnabled(false, true, true), true)
  assert.equal(micEnabled(true, true, true), true)
  assert.equal(micEnabled(true, true, false), false)
})
