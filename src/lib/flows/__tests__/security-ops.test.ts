import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runSecurityOp } from '@/lib/flows/security-ops'

const output = (result: ReturnType<typeof runSecurityOp>) => {
  assert.ok(!('error' in result), 'error' in result ? result.error : '')
  return (result as { output: unknown }).output
}

describe('workflow security utilities', () => {
  it('creates SHA-256 hashes and HMACs', () => {
    assert.equal(output(runSecurityOp('hash', { input: 'abc', algorithm: 'sha256' })), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    assert.equal(output(runSecurityOp('hmac', { input: 'data', secret: '12345678', algorithm: 'sha256' })), '31741b39ac45a925af9050e0d40ff461218d1937fb9cc585d026b7a1a3af3713')
  })

  it('signs and verifies time-bounded JWT claims', () => {
    const secret = 'correct horse battery staple'
    const token = output(runSecurityOp('jwtSign', {
      input: { sub: 'user-1' },
      secret,
      algorithm: 'HS256',
      nowUnix: 1_000,
      expiresInSeconds: 60,
      issuer: 'backstory',
      audience: 'workflow',
    })) as string
    const verified = output(runSecurityOp('jwtVerify', {
      input: token,
      secret,
      algorithm: 'HS256',
      nowUnix: 1_030,
      issuer: 'backstory',
      audience: 'workflow',
    })) as { valid: boolean; claims: Record<string, unknown> }
    assert.equal(verified.valid, true)
    assert.equal(verified.claims.sub, 'user-1')
    assert.match((runSecurityOp('jwtVerify', { input: token, secret, algorithm: 'HS256', nowUnix: 1_060 }) as { error: string }).error, /expired/)
  })

  it('matches the RFC 6238 SHA-1 vector and verifies with bounded skew', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
    assert.equal(output(runSecurityOp('totpGenerate', { input: null, secret, algorithm: 'sha1', nowUnix: 59, digits: 8, period: 30 })), '94287082')
    assert.deepEqual(output(runSecurityOp('totpVerify', { input: '94287082', secret, algorithm: 'sha1', nowUnix: 60, digits: 8, period: 30 })), { valid: true })
  })
})
