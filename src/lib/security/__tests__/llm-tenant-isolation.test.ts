import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * No prompt may reach another workspace's data.
 *
 * The tenant guard enforces org scoping on every query through the guarded
 * client — but `systemPrisma` bypasses it by design, for enumerated system
 * paths. The question this pins is therefore narrow and specific: inside the
 * code a model can steer (the agent runtime, the flow executor, tool loading),
 * every systemPrisma call must be keyed on ids the RUN already owns, never on
 * anything the model produces.
 *
 * An audit established that today (each call is an id-keyed write to the run's
 * own execution/task/outbox rows). This test keeps "reachable from a prompt"
 * and "bypasses the tenant guard" from silently intersecting in a new way: a
 * NEW systemPrisma call in these files fails the count until a human confirms
 * it is still keyed on run-owned ids and raises the pin.
 */

const SRC = path.join(process.cwd(), 'src')

/**
 * Files whose execution a model's output can influence, with the number of
 * systemPrisma call sites each carried when last audited.
 *
 * The COUNT is the pin, not the line numbers — line numbers churn with every
 * edit, while a rising count is exactly the review trigger wanted here. A
 * falling count is fine and just means cleanup; update the pin.
 */
const AUDITED_BYPASS_COUNTS: Record<string, number> = {
  'features/agents/execute-agent.ts': 16,
  'features/flows/execute-flow.ts': 0,
  'features/agents/tool-planes.ts': 0,
  'lib/mcp/connection-token.ts': 1,
  'lib/integrations/http.ts': 0,
  'lib/integrations/org-credential.ts': 0,
}

function countBypasses(relative: string): number {
  const source = readFileSync(path.join(SRC, relative), 'utf8')
  return (source.match(/\bsystemPrisma\./g) ?? []).length
}

test('model-steerable files gain no new tenant-guard bypasses unreviewed', () => {
  const drift: string[] = []

  for (const [relative, expected] of Object.entries(AUDITED_BYPASS_COUNTS)) {
    const actual = countBypasses(relative)
    if (actual > expected) {
      drift.push(`${relative}: ${actual} systemPrisma calls, ${expected} audited`)
    }
  }

  assert.deepEqual(
    drift,
    [],
    `new tenant-guard bypasses in model-steerable code: ${drift.join('; ')}. ` +
      'Confirm each new call is keyed on ids the run already owns (its own execution, task, ' +
      'outbox row) and never on model-produced values, then raise the audited count.',
  )
})

test('the pinned files still exist and still matter', () => {
  // A moved or deleted file would make its pin vacuous; surface that instead
  // of silently guarding nothing.
  for (const relative of Object.keys(AUDITED_BYPASS_COUNTS)) {
    assert.doesNotThrow(() => readFileSync(path.join(SRC, relative), 'utf8'), `${relative} is gone — update the pin`)
  }
})

test('tool loading takes organizationId from the run, not from tool arguments', () => {
  // The one call shape that would break isolation outright: loadTools deciding
  // its workspace from anything the model can write.
  const source = readFileSync(path.join(SRC, 'features/agents/execute-agent.ts'), 'utf8')
  assert.match(
    source,
    /loadTools\(organizationId,/,
    'loadTools must be called with the run-scoped organizationId as its first argument',
  )
})
