import { test } from 'node:test'
import assert from 'node:assert/strict'
import { roleLabelInputsChanged, sanitizeRoleLabel } from '../role-label'

test('keeps a clean 1-2 word label, title-cased', () => {
  assert.equal(sanitizeRoleLabel('deal researcher'), 'Deal Researcher')
  assert.equal(sanitizeRoleLabel('Reporter'), 'Reporter')
})

test('strips quotes, periods, and surrounding chatter punctuation', () => {
  assert.equal(sanitizeRoleLabel('"Pipeline Reporter."'), 'Pipeline Reporter')
  assert.equal(sanitizeRoleLabel('“Account Watcher”'), 'Account Watcher')
})

test('clamps sentences to the first two words', () => {
  assert.equal(sanitizeRoleLabel('Sales research assistant for enterprise deals'), 'Sales Research')
})

test('rejects garbage: empty, non-string, no letters, or too long', () => {
  assert.equal(sanitizeRoleLabel(''), null)
  assert.equal(sanitizeRoleLabel('   '), null)
  assert.equal(sanitizeRoleLabel(42), null)
  assert.equal(sanitizeRoleLabel('123 456'), null)
  assert.equal(sanitizeRoleLabel('Antidisestablishmentarian Prognosticator'), null)
})

test('splits slashed roles into words', () => {
  assert.equal(sanitizeRoleLabel('Researcher/Writer'), 'Researcher Writer')
})

test('an avatar-only full-form save does not invalidate the role label', () => {
  const current = {
    title: 'Deal Watcher',
    description: 'Watches important deals.',
    instructions: 'Review open opportunities every morning.',
  }
  assert.equal(roleLabelInputsChanged(current, { ...current }), false)
  assert.equal(roleLabelInputsChanged(current, {}), false)
})

test('a real job-description edit invalidates the role label', () => {
  const current = {
    title: 'Deal Watcher',
    description: 'Watches important deals.',
    instructions: 'Review open opportunities every morning.',
  }
  assert.equal(roleLabelInputsChanged(current, { title: 'Pipeline Coach' }), true)
  assert.equal(roleLabelInputsChanged(current, { description: 'Coaches every rep.' }), true)
  assert.equal(roleLabelInputsChanged(current, { instructions: 'Send coaching notes.' }), true)
})
