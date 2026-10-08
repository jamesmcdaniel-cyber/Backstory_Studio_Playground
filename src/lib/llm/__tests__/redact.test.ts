import test from 'node:test'
import assert from 'node:assert/strict'
import { EgressVault } from '../redact'

test('emails and phones become stable placeholders that keep their shape, and come back', () => {
  const vault = new EgressVault()
  const text = 'Mail Ada.Lovelace@Acme.com or call +1 (415) 555-0134; her peer bo@acme.com is on 415-555-0199.'
  const masked = vault.pseudonymize(text)
  assert.doesNotMatch(masked, /acme\.com|555-01/i)
  assert.match(masked, /adalov1@redacted\.invalid/)
  assert.match(masked, /bo2@redacted\.invalid/)
  assert.match(masked, /\+000 0001/)
  assert.equal(vault.pseudonymize('ada.lovelace@acme.com again'), 'adalov1@redacted.invalid again', 'the same identifier maps to the same token, case-insensitively')
  assert.equal(vault.restore(masked), text, 'restored as first seen, formatting and casing included')
  assert.equal(vault.size, 4)
})

test('card and national-id numbers are masked outright; short numbers and years are left alone', () => {
  const vault = new EgressVault()
  assert.equal(vault.pseudonymize('card 4111 1111 1111 1111, ssn 123-45-6789, FY2026 revenue 1200000'), 'card [card ending 1111], ssn [national id], FY2026 revenue 1200000')
})

test('deep values are copied with every string masked, and restored the same way', () => {
  const vault = new EgressVault()
  const input = { to: ['cfo@globex.example'], body: 'Call 020 7946 0958', n: 3 }
  const masked = vault.pseudonymizeDeep(input)
  assert.notEqual(masked, input)
  assert.deepEqual(vault.restoreDeep(masked), input)
})
