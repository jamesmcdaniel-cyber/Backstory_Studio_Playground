import assert from 'node:assert/strict'
import test from 'node:test'
import { isCompanyEmail } from '../company-domain'

test('isCompanyEmail accepts the two managed company domains', () => {
  assert.equal(isCompanyEmail('person@people.ai'), true)
  assert.equal(isCompanyEmail('PERSON@BACKSTORY.AI'), true)
})

test('isCompanyEmail rejects personal, missing, and lookalike domains', () => {
  assert.equal(isCompanyEmail('person@gmail.com'), false)
  assert.equal(isCompanyEmail('person@people.ai.attacker.example'), false)
  assert.equal(isCompanyEmail('person@notpeople.ai'), false)
  assert.equal(isCompanyEmail('people.ai'), false)
  assert.equal(isCompanyEmail(null), false)
})
