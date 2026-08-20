/**
 * Demo snapshot schema guard.
 *
 * Every model that carries an `organizationId` must be explicitly placed by
 * the snapshot engine — copied in full, copied bounded, copied as a
 * credential-free shell, or excluded with a written reason. A new org-scoped
 * model that nobody placed fails here, so the demo-mode design cannot rot as
 * the schema grows (same shape as the flows secret-surface guard).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { COPY_FULL, COPY_BOUNDED, COPY_SHELL, EXCLUDED, PARENT_SCOPED_COPIES } from '../snapshot'

function orgScopedModels(): string[] {
  const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8')
  const models = schema.matchAll(/model (\w+) \{([\s\S]*?)\n\}/g)
  const scoped: string[] = []
  for (const [, name, body] of models) {
    if (/^\s*organizationId\s/m.test(body)) scoped.push(name)
  }
  return scoped
}

test('every org-scoped model is placed by the snapshot engine', () => {
  const placed = new Set([...COPY_FULL, ...COPY_BOUNDED, ...COPY_SHELL, ...Object.keys(EXCLUDED)])
  const missing = orgScopedModels().filter((model) => !placed.has(model))
  assert.deepEqual(missing, [], `Unplaced org-scoped models: ${missing.join(', ')} — add each to a copy list or to EXCLUDED with a reason in src/lib/demo/snapshot.ts`)
})

test('every exclusion carries a written reason', () => {
  for (const [model, reason] of Object.entries(EXCLUDED)) {
    assert.ok(reason.length >= 15, `EXCLUDED.${model} needs a real reason, not "${reason}"`)
  }
})

test('no model is placed twice', () => {
  const all = [...COPY_FULL, ...COPY_BOUNDED, ...COPY_SHELL, ...PARENT_SCOPED_COPIES, ...Object.keys(EXCLUDED)]
  assert.equal(new Set(all).size, all.length)
})
