import test from 'node:test'
import assert from 'node:assert/strict'
import { hashToken } from '@/lib/crypto/secrets'
import { hasLegacyPlaintextTriggerSecret, verifyAgentTriggerSecret } from '../trigger-secret'

test('a hashed secret verifies only against the matching plaintext', () => {
  const metadata = { triggerSecretHash: hashToken('s3cret') }
  assert.equal(verifyAgentTriggerSecret('s3cret', metadata), 'ok')
  assert.equal(verifyAgentTriggerSecret('s3cret!', metadata), 'invalid')
  assert.equal(verifyAgentTriggerSecret('', metadata), 'invalid')
})

test('a legacy plaintext secret is refused even when the caller presents it exactly', () => {
  // The old fallback would have answered 'ok' here. The whole point is that a
  // plaintext column is never a credential the route will honour again.
  assert.equal(verifyAgentTriggerSecret('plain', { triggerSecret: 'plain' }), 'legacy_plaintext')
  assert.equal(verifyAgentTriggerSecret('wrong', { triggerSecret: 'plain' }), 'legacy_plaintext')
})

test('a row carrying both uses the hash and ignores the plaintext', () => {
  const metadata = { triggerSecretHash: hashToken('new'), triggerSecret: 'old' }
  assert.equal(verifyAgentTriggerSecret('new', metadata), 'ok')
  assert.equal(verifyAgentTriggerSecret('old', metadata), 'invalid')
  assert.equal(hasLegacyPlaintextTriggerSecret(metadata), false)
})

test('no secret at all is simply invalid', () => {
  assert.equal(verifyAgentTriggerSecret('anything', {}), 'invalid')
  assert.equal(verifyAgentTriggerSecret('anything', { triggerSecret: '' }), 'invalid')
  assert.equal(hasLegacyPlaintextTriggerSecret({}), false)
  assert.equal(hasLegacyPlaintextTriggerSecret({ triggerSecret: 'x' }), true)
})
