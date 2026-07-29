import assert from 'node:assert/strict'
import test from 'node:test'
import { validatedReturnPath } from '../return-path'

test('validatedReturnPath preserves internal deep links', () => {
  assert.equal(validatedReturnPath('/dashboard'), '/dashboard')
  assert.equal(validatedReturnPath('/flows/flow-1?panel=activity'), '/flows/flow-1?panel=activity')
})

test('validatedReturnPath rejects external and ambiguous redirects', () => {
  assert.equal(validatedReturnPath('https://attacker.example'), null)
  assert.equal(validatedReturnPath('//attacker.example'), null)
  assert.equal(validatedReturnPath('/\\attacker.example'), null)
  assert.equal(validatedReturnPath('dashboard'), null)
  assert.equal(validatedReturnPath(null), null)
  assert.equal(validatedReturnPath(undefined), null)
  assert.equal(validatedReturnPath(''), null)
})

test('validatedReturnPath trims surrounding whitespace but rejects embedded control characters', () => {
  assert.equal(validatedReturnPath('  /flows/f1?share=tok  '), '/flows/f1?share=tok')
  assert.equal(validatedReturnPath('/flows\nabc'), null, 'newline could split a header')
  assert.equal(validatedReturnPath('/flows\rabc'), null)
  assert.equal(validatedReturnPath('/ /attacker.example'), '/ /attacker.example', 'a space is a path character, not an escape')
})
