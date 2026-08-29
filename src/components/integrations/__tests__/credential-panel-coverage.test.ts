import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CREDENTIAL_PROVIDERS } from '@/lib/integrations/credential-providers'

/**
 * The panel's PROVIDERS list is a hand-kept copy of the registry (see the
 * comment there). A provider present in the registry but missing from the
 * panel is an integration a customer workspace can never turn on — it fails
 * silently as "not configured" with no place in the product to fix it.
 */
test('the credentials panel offers every registered credential provider', () => {
  const source = readFileSync(new URL('../workspace-credentials-panel.tsx', import.meta.url), 'utf8')
  const declared = /const PROVIDERS = \[([^\]]+)\] as const/.exec(source)?.[1]
  assert.ok(declared, 'the panel declares a PROVIDERS list')
  const inPanel = [...declared!.matchAll(/'([a-z_]+)'/g)].map((match) => match[1])
  assert.deepEqual(inPanel.sort(), [...CREDENTIAL_PROVIDERS].sort())
})
