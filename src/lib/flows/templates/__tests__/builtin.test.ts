import test from 'node:test'
import assert from 'node:assert/strict'
import { flowGraphSchema } from '@/lib/flows/graph'
import { validateFlowGraph } from '@/lib/flows/validate'
import { BUILTIN_FLOW_TEMPLATES } from '@/lib/flows/templates/builtin'
import { flowTemplateNotesIssues, flowTemplateNotesSchema, flowTemplateBindingSchema } from '@/lib/flows/templates/types'

/**
 * The catalogue's contract. A built-in that violates any of these ships a
 * broken "Use this flow" to every workspace, so these run on every commit.
 */

test('every built-in graph parses the flow graph schema', () => {
  for (const template of BUILTIN_FLOW_TEMPLATES) {
    assert.doesNotThrow(() => flowGraphSchema.parse(template.graph), `${template.id} graph does not parse`)
  }
})

test('built-in ids and node ids are unique', () => {
  const ids = BUILTIN_FLOW_TEMPLATES.map((template) => template.id)
  assert.equal(new Set(ids).size, ids.length, 'duplicate template id')
  for (const template of BUILTIN_FLOW_TEMPLATES) {
    const nodeIds = template.graph.nodes.map((node) => node.id)
    assert.equal(new Set(nodeIds).size, nodeIds.length, `${template.id} has duplicate node ids`)
  }
})

test('built-in notes and bindings parse their schemas', () => {
  for (const template of BUILTIN_FLOW_TEMPLATES) {
    assert.doesNotThrow(() => flowTemplateNotesSchema.parse(template.notes), `${template.id} notes do not parse`)
    assert.doesNotThrow(() => flowTemplateBindingSchema.array().parse(template.bindings), `${template.id} bindings do not parse`)
  }
})

test('every executable step is explained, on the canvas and in the notes', () => {
  for (const template of BUILTIN_FLOW_TEMPLATES) {
    const issues = flowTemplateNotesIssues(template.graph, template.notes, template.bindings)
    assert.deepEqual(issues, [], `${template.id}: ${issues.join(' | ')}`)
  }
})

test('notes never leak raw token syntax to the reader', () => {
  for (const template of BUILTIN_FLOW_TEMPLATES) {
    for (const field of [template.name, template.description, ...template.bindings.map((b) => b.label)]) {
      assert.ok(!field.includes('{{'), `${template.id} shows token syntax in "${field}"`)
    }
  }
})

/**
 * A portable template ships agent/connection slots empty on purpose, so the
 * only validation errors allowed are the ones that name a step with a declared
 * binding. Anything else is a genuine authoring bug.
 */
test('built-ins validate cleanly apart from their declared, unfilled slots', () => {
  for (const template of BUILTIN_FLOW_TEMPLATES) {
    const boundNodes = new Set(template.bindings.map((binding) => binding.nodeId))
    const unexpected = validateFlowGraph(template.graph, { requireRunnable: true }).errors.filter(
      (error) => !error.nodeId || !boundNodes.has(error.nodeId),
    )
    assert.deepEqual(
      unexpected.map((error) => `${error.nodeId ?? 'flow'}: ${error.message}`),
      [],
      `${template.id} has validation errors that no binding explains`,
    )
  }
})

test('every empty agent or connection slot has a binding that fills it', () => {
  for (const template of BUILTIN_FLOW_TEMPLATES) {
    const bound = new Set(template.bindings.map((binding) => binding.nodeId))
    for (const node of template.graph.nodes) {
      if (node.type === 'agent' && !node.data.agentId) {
        assert.ok(bound.has(node.id), `${template.id}: agent step "${node.id}" is empty with no binding`)
      }
      if (node.type === 'tool' && !node.data.connectionId) {
        assert.ok(bound.has(node.id), `${template.id}: tool step "${node.id}" is empty with no binding`)
      }
    }
  }
})

test('starter templates need no setup at all', () => {
  for (const id of ['summarize-extract', 'score-each-item', 'scheduled-wait']) {
    const template = BUILTIN_FLOW_TEMPLATES.find((entry) => entry.id === id)
    assert.ok(template, `${id} is missing from the catalogue`)
    assert.deepEqual(template.bindings, [], `${id} should instantiate with no bindings to resolve`)
  }
})
