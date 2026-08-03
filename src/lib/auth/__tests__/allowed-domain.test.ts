import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDomain, isPublicEmailProvider } from '@/lib/auth/company-domain'

test('normalizeDomain lowercases and trims a bare domain', () => {
  assert.equal(normalizeDomain('  Customer.COM '), 'customer.com')
  assert.equal(normalizeDomain('customer.com'), 'customer.com')
})

test('normalizeDomain strips a leading @ so pasted addresses work', () => {
  assert.equal(normalizeDomain('@customer.com'), 'customer.com')
})

test('normalizeDomain rejects wildcards, paths, and malformed input', () => {
  assert.equal(normalizeDomain('*.customer.com'), null)
  assert.equal(normalizeDomain('customer.com/path'), null)
  assert.equal(normalizeDomain('customer'), null)
  assert.equal(normalizeDomain('cust omer.com'), null)
  assert.equal(normalizeDomain(''), null)
  assert.equal(normalizeDomain(null), null)
})

test('normalizeDomain rejects a full email address', () => {
  assert.equal(normalizeDomain('person@customer.com'), null)
})

test('isPublicEmailProvider blocks free providers that would open the platform', () => {
  assert.equal(isPublicEmailProvider('gmail.com'), true)
  assert.equal(isPublicEmailProvider('GMAIL.COM'), true)
  assert.equal(isPublicEmailProvider('outlook.com'), true)
  assert.equal(isPublicEmailProvider('yahoo.com'), true)
  assert.equal(isPublicEmailProvider('hotmail.com'), true)
  assert.equal(isPublicEmailProvider('icloud.com'), true)
  assert.equal(isPublicEmailProvider('proton.me'), true)
})

test('isPublicEmailProvider allows a real corporate domain', () => {
  assert.equal(isPublicEmailProvider('customer.com'), false)
  assert.equal(isPublicEmailProvider('people.ai'), false)
})
