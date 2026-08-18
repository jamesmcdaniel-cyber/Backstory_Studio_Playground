import test from 'node:test'
import assert from 'node:assert/strict'
import { Prisma } from '@prisma/client'
import { isOmittedExportKey, NOT_SECRET_KEYS } from '../export'
import { ORG_SCOPED_MODELS } from '@/lib/tenant-guard'

/**
 * The workspace export is downloaded, archived, and handed to third parties,
 * and its manifest claims `secretsIncluded: false`. This walks the REAL schema
 * so that claim is checked against every column that actually exists rather
 * than against a list someone remembered to update.
 */
const EXPORTED_MODELS = new Set<string>([...ORG_SCOPED_MODELS, 'User', 'Organization'])

test('no credential-named column in any exported model survives the export filter', () => {
  const leaked: string[] = []
  for (const model of Prisma.dmmf.datamodel.models) {
    if (!EXPORTED_MODELS.has(model.name)) continue
    for (const field of model.fields) {
      if (field.kind === 'object') continue // relations are not emitted as values
      // Anything a reviewer would read as a credential must be omitted, OR
      // deliberately classified as not-a-secret in export.ts. A new column
      // satisfying neither fails here rather than shipping in every export.
      if (!/(token|secret|password|passphrase|credential|api[-_]?key|privatekey)/i.test(field.name)) continue
      if (isOmittedExportKey(field.name) || NOT_SECRET_KEYS.has(field.name)) continue
      leaked.push(`${model.name}.${field.name}`)
    }
  }
  assert.deepEqual(leaked, [], `these credential-named columns would be exported: ${leaked.join(', ')}`)
})

test('the specific tokens that leaked before are omitted', () => {
  // Flow.shareToken is the sharp one: live, non-expiring, and it opens the flow
  // from another workspace — or with no session when shareAnonymous is set.
  for (const key of ['shareToken', 'shareTokenDigest', 'verificationToken', 'triggerSecret', 'resumeTokenHash', 'tokenHash', 'secretConfig']) {
    assert.equal(isOmittedExportKey(key), true, `${key} must never be exported`)
  }
})

test('token counters are usage data and stay in the export', () => {
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    assert.equal(isOmittedExportKey(key), false, `${key} is usage data the customer is entitled to`)
  }
})

test('ordinary customer content is never mistaken for a credential', () => {
  for (const key of ['name', 'description', 'graph', 'instructions', 'createdAt', 'organizationId', 'status']) {
    assert.equal(isOmittedExportKey(key), false, `${key} must be exported`)
  }
})
