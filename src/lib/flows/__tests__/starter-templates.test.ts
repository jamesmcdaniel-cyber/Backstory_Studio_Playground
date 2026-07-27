import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STARTER_TEMPLATES } from '../starter-templates'
import { flowGraphSchema } from '../graph'
import { validateFlowGraph } from '../validate'

test('every starter template is a schema-valid, error-free flow graph', () => {
  for (const template of STARTER_TEMPLATES) {
    const parsed = flowGraphSchema.safeParse(template.graph)
    assert.ok(parsed.success, `${template.id}: schema ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`)
    const result = validateFlowGraph(template.graph)
    assert.deepEqual(result.errors, [], `${template.id}: ${JSON.stringify(result.errors)}`)
  }
})

test('starter template ids are unique', () => {
  const ids = STARTER_TEMPLATES.map((t) => t.id)
  assert.equal(new Set(ids).size, ids.length)
})
