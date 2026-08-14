import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

/**
 * The v2 key-id format exists so ENCRYPTION_KEY can actually be rotated. These
 * tests pin the properties the rotation depends on: a payload names its key, a
 * retired key stays readable while it is in the ring, and a key that is gone
 * fails loudly with the id it wanted rather than returning garbage.
 *
 * Kept separate from secrets.test.ts so neither file approaches the ~45KB size
 * where tsx + node 22 hangs at load.
 */

// The module reads the environment per call, but tests still re-import a fresh
// copy so the one-time "not configured" warn flag can't leak between them.
async function freshSecrets() {
  const mod = await import(`../secrets?t=${Date.now()}-${Math.random()}`)
  return mod as typeof import('../secrets')
}

const ORIGINAL_ENV = { ...process.env }

const OLD_KEY = 'old-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NEW_KEY = 'new-key-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

/** The id the implementation should stamp — SHA-256 of the derived key. */
function expectedKeyId(raw: string): string {
  const derived = crypto.createHash('sha256').update(raw).digest()
  return crypto.createHash('sha256').update(derived).digest('hex').slice(0, 8)
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

test('encryptSecret writes v2 stamped with the active key id', async () => {
  process.env.ENCRYPTION_KEY = NEW_KEY
  delete process.env.ENCRYPTION_KEY_PREVIOUS
  const { encryptSecret, activeKeyId } = await freshSecrets()

  const payload = encryptSecret('hunter2')
  assert.match(payload, /^v2:[0-9a-f]{8}:/)
  assert.equal(payload.split(':')[1], expectedKeyId(NEW_KEY))
  assert.equal(activeKeyId(), expectedKeyId(NEW_KEY))
})

test('the key id is a digest of the key, never key material', async () => {
  process.env.ENCRYPTION_KEY = NEW_KEY
  const { encryptSecret } = await freshSecrets()

  const keyId = encryptSecret('x').split(':')[1]
  const derived = crypto.createHash('sha256').update(NEW_KEY).digest('hex')
  assert.notEqual(keyId, derived.slice(0, 8))
  assert.ok(!NEW_KEY.includes(keyId))
})

test('round-trips under the active key', async () => {
  process.env.ENCRYPTION_KEY = NEW_KEY
  const { encryptSecret, decryptSecret } = await freshSecrets()
  assert.equal(decryptSecret(encryptSecret('hunter2')), 'hunter2')
})

test('dual-read: a payload written under the retired key still decrypts', async () => {
  // Written before the rotation...
  process.env.ENCRYPTION_KEY = OLD_KEY
  delete process.env.ENCRYPTION_KEY_PREVIOUS
  const before = await freshSecrets()
  const stored = before.encryptSecret('rotate-me')

  // ...and read after it, with the old key demoted to the previous slot.
  process.env.ENCRYPTION_KEY = NEW_KEY
  process.env.ENCRYPTION_KEY_PREVIOUS = OLD_KEY
  const after = await freshSecrets()
  assert.equal(after.decryptSecret(stored), 'rotate-me')
})

test('single-write: new writes use the new key even while the old one is readable', async () => {
  process.env.ENCRYPTION_KEY = NEW_KEY
  process.env.ENCRYPTION_KEY_PREVIOUS = OLD_KEY
  const { encryptSecret } = await freshSecrets()
  assert.equal(encryptSecret('fresh').split(':')[1], expectedKeyId(NEW_KEY))
})

test('a retired key dropped from the ring fails loudly, naming the id it needs', async () => {
  process.env.ENCRYPTION_KEY = OLD_KEY
  delete process.env.ENCRYPTION_KEY_PREVIOUS
  const before = await freshSecrets()
  const stranded = before.encryptSecret('stranded')

  // ENCRYPTION_KEY_PREVIOUS unset too early — the classic rotation mistake.
  process.env.ENCRYPTION_KEY = NEW_KEY
  delete process.env.ENCRYPTION_KEY_PREVIOUS
  const after = await freshSecrets()

  assert.throws(
    () => after.decryptSecret(stranded),
    new RegExp(`No configured key matches id ${expectedKeyId(OLD_KEY)}`),
  )
})

test('ENCRYPTION_KEY_PREVIOUS accepts a comma-separated list', async () => {
  process.env.ENCRYPTION_KEY = 'first-key-cccccccccccccccccccccccccccc'
  const first = await freshSecrets()
  const fromFirst = first.encryptSecret('one')

  process.env.ENCRYPTION_KEY = OLD_KEY
  const second = await freshSecrets()
  const fromSecond = second.encryptSecret('two')

  // An interrupted rotation leaves payloads on two retired keys at once.
  process.env.ENCRYPTION_KEY = NEW_KEY
  process.env.ENCRYPTION_KEY_PREVIOUS = ` ${OLD_KEY} , first-key-cccccccccccccccccccccccccccc `
  const third = await freshSecrets()

  assert.equal(third.decryptSecret(fromFirst), 'one')
  assert.equal(third.decryptSecret(fromSecond), 'two')
})

test('legacy v1 payloads are read by trying the ring — GCM makes a wrong key fail, not lie', async () => {
  process.env.ENCRYPTION_KEY = OLD_KEY
  const { decryptSecret } = await freshSecrets()

  // Hand-build a v1 payload under OLD_KEY: the format predates key ids, so
  // there is nothing in it to look the key up by.
  const key = crypto.createHash('sha256').update(OLD_KEY).digest()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update('legacy', 'utf8'), cipher.final()])
  const v1 = ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':')

  assert.equal(decryptSecret(v1), 'legacy')

  process.env.ENCRYPTION_KEY = NEW_KEY
  process.env.ENCRYPTION_KEY_PREVIOUS = OLD_KEY
  const rotated = await freshSecrets()
  assert.equal(rotated.decryptSecret(v1), 'legacy')

  process.env.ENCRYPTION_KEY = NEW_KEY
  delete process.env.ENCRYPTION_KEY_PREVIOUS
  const stranded = await freshSecrets()
  assert.throws(() => stranded.decryptSecret(v1), /No configured key can decrypt this v1 secret/)
})

test('isCurrentKeyPayload distinguishes what the rotation script must rewrite', async () => {
  process.env.ENCRYPTION_KEY = OLD_KEY
  const before = await freshSecrets()
  const old = before.encryptSecret('x')

  process.env.ENCRYPTION_KEY = NEW_KEY
  process.env.ENCRYPTION_KEY_PREVIOUS = OLD_KEY
  const after = await freshSecrets()

  assert.equal(after.isCurrentKeyPayload(old), false)
  assert.equal(after.isCurrentKeyPayload(after.encryptSecret('x')), true)
  assert.equal(after.isCurrentKeyPayload('b64:eA=='), false)
  assert.equal(after.isCurrentKeyPayload('v1:a:b:c'), false)
})
