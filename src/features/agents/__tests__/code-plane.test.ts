import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { BUILTIN_CONNECTORS, isWriteProvider } from '@/lib/connectors/registry'

test('code execution is a builtin, read-only plane', () => {
  const descriptor = BUILTIN_CONNECTORS.find((connector) => connector.providerId === 'code')
  assert.ok(descriptor, 'code must be registered as a builtin connector')
  assert.equal(descriptor!.isWrite, false)
  assert.equal(isWriteProvider('code'), false)
  assert.equal(descriptor!.available(), true)
})

test('every agent gets the code plane, not only ones that selected it', () => {
  // An agent handed a CSV without it can only refuse or guess at the numbers.
  const source = readFileSync(new URL('../execute-agent.ts', import.meta.url), 'utf8')
  // Every agent: its own providers plus repository and code. A conversation
  // about an ROI dashboard narrows the list to its own planes — code included.
  assert.match(source, /\[\.\.\.providers, 'repository', 'code'\]/)
  assert.match(source, /dashboardOnly \? \['repository', 'code', 'roi'\]/)
})
