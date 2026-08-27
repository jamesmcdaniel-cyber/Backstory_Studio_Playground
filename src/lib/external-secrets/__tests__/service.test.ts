import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pathAllowed,
  selectSecretProperty,
  validateExternalSecretProviderConfig,
} from '../service'

test('path-prefix policy requires a full path segment', () => {
  assert.equal(pathAllowed('production/api', 'production'), true)
  assert.equal(pathAllowed('production', 'production'), true)
  assert.equal(pathAllowed('production-other/api', 'production'), false)
  assert.throws(() => pathAllowed('../metadata', 'production'), /invalid/)
})

test('JSON secret properties resolve without prototype traversal', () => {
  assert.equal(selectSecretProperty('{"database":{"password":"secret"}}', 'database.password'), 'secret')
  assert.equal(selectSecretProperty('{"port":5432}', 'port'), '5432')
  assert.throws(() => selectSecretProperty('{"safe":true}', '__proto__.x'), /invalid/)
  assert.throws(() => selectSecretProperty('plain', 'password'), /not JSON/)
})

test('Azure providers are restricted to Key Vault domains', () => {
  assert.deepEqual(
    validateExternalSecretProviderConfig('azure', { vaultUrl: 'https://acme.vault.azure.net' }),
    { vaultUrl: 'https://acme.vault.azure.net' },
  )
  assert.throws(
    () => validateExternalSecretProviderConfig('azure', { vaultUrl: 'https://example.com' }),
    /Key Vault domain/,
  )
})
