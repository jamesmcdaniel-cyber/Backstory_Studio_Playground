import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  __resetKeyMaterialForTests,
  cachedKeyMaterial,
  configuredProvider,
  initializeKeyMaterial,
  splitPrevious,
} from '../key-source'

/**
 * The property that matters most here is the FALLBACK: with no initialization,
 * secrets.ts must behave exactly as it did when it read process.env directly.
 * Every unit test, script and the rotation tool depend on that, and breaking it
 * would be a silent, repo-wide behaviour change dressed up as a security
 * improvement.
 */

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV }
  __resetKeyMaterialForTests()
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  __resetKeyMaterialForTests()
})

test('with no initialization there is no cached material, so callers fall back to env', () => {
  assert.equal(cachedKeyMaterial(), null)
})

test('the provider defaults to env — a KMS must never be required to boot locally', () => {
  delete process.env.ENCRYPTION_KEY_PROVIDER
  assert.equal(configuredProvider(), 'env')
})

test('an unrecognised provider is rejected loudly rather than silently falling back', () => {
  // Falling back to env on a typo would mean a deployment that believes it is
  // using Vault is quietly reading a plaintext env var instead.
  process.env.ENCRYPTION_KEY_PROVIDER = 'valut'
  assert.throws(() => configuredProvider(), /Unknown ENCRYPTION_KEY_PROVIDER/)
})

test('provider names are matched case- and whitespace-insensitively', () => {
  process.env.ENCRYPTION_KEY_PROVIDER = '  Vault '
  assert.equal(configuredProvider(), 'vault')
})

test('the env provider loads the key and its retired ring', async () => {
  process.env.ENCRYPTION_KEY_PROVIDER = 'env'
  process.env.ENCRYPTION_KEY = 'primary-key'
  process.env.ENCRYPTION_KEY_PREVIOUS = 'old-a, old-b'

  const material = await initializeKeyMaterial()

  assert.equal(material.provider, 'env')
  assert.equal(material.primary, 'primary-key')
  assert.deepEqual(material.previous, ['old-a', 'old-b'])
  assert.deepEqual(cachedKeyMaterial(), material, 'material is cached for the sync callers')
})

test('a provider that yields no primary key fails initialization', async () => {
  // Booting with no usable key would mean every credential read fails one at a
  // time, at request time, looking like an integration problem.
  process.env.ENCRYPTION_KEY_PROVIDER = 'env'
  delete process.env.ENCRYPTION_KEY

  await assert.rejects(() => initializeKeyMaterial(), /returned no primary key/)
})

test('a misconfigured non-env provider names itself in the failure', async () => {
  process.env.ENCRYPTION_KEY_PROVIDER = 'vault'
  delete process.env.VAULT_ADDR

  await assert.rejects(
    () => initializeKeyMaterial(),
    (error: unknown) => {
      const message = (error as Error).message
      // Both halves matter: which provider, and which variable is missing.
      return /vault/.test(message) && /VAULT_ADDR/.test(message)
    },
  )
})

test('splitPrevious tolerates the ragged forms env vars actually arrive in', () => {
  assert.deepEqual(splitPrevious('a, b ,,c'), ['a', 'b', 'c'])
  assert.deepEqual(splitPrevious(''), [])
  assert.deepEqual(splitPrevious(undefined), [])
  assert.deepEqual(splitPrevious(null), [])
})
