import test from 'node:test'
import assert from 'node:assert/strict'
import { flowGraphSchema } from '@/lib/flows/graph'
import { validateFlowGraph } from '@/lib/flows/validate'
import { flowTemplateNotesIssues, flowTemplateNotesSchema } from '@/lib/flows/templates/types'
import { ROI_DATA_FLOW_TEMPLATE_ID, ROI_DATA_PULL_DATABRICKS } from '../data-flow-template'
import { ORG_ID_PLACEHOLDER, ROI_WAREHOUSE_KINDS, ROI_WAREHOUSE_QUERIES, warehouseSql } from '../warehouse-queries'
import { ROI_SOURCE_KINDS } from '../sources'
import { ROI_TOOLS } from '../tools'

/**
 * The ROI data flow as the catalogue ships it: a parseable, explained,
 * runnable-apart-from-credentials graph whose three extracts are the kinds the
 * ROI page reads, and whose queries carry no workspace's org id.
 */

test('the template parses, is explained step by step, and validates with nothing left unbound', () => {
  assert.doesNotThrow(() => flowGraphSchema.parse(ROI_DATA_PULL_DATABRICKS.graph))
  assert.doesNotThrow(() => flowTemplateNotesSchema.parse(ROI_DATA_PULL_DATABRICKS.notes))
  assert.deepEqual(flowTemplateNotesIssues(ROI_DATA_PULL_DATABRICKS.graph, ROI_DATA_PULL_DATABRICKS.notes, ROI_DATA_PULL_DATABRICKS.bindings), [])
  const errors = validateFlowGraph(ROI_DATA_PULL_DATABRICKS.graph, { requireRunnable: true }).errors
  assert.deepEqual(errors.map((error) => `${error.nodeId ?? 'flow'}: ${error.message}`), [])
  assert.equal(ROI_DATA_PULL_DATABRICKS.id, ROI_DATA_FLOW_TEMPLATE_ID)
  for (const field of [ROI_DATA_PULL_DATABRICKS.name, ROI_DATA_PULL_DATABRICKS.description]) assert.ok(!field.includes('{{'), 'no raw token syntax where a person reads')
})

test('it names the three extract kinds the ROI page reads, and runs them through the ROI plane\'s pull tool', () => {
  assert.deepEqual([...ROI_WAREHOUSE_KINDS], ['activity', 'engagement', 'stages'])
  for (const kind of ROI_WAREHOUSE_KINDS) assert.ok((ROI_SOURCE_KINDS as readonly string[]).includes(kind), `${kind} is an ROI_SOURCE_KINDS member`)
  assert.deepEqual(ROI_WAREHOUSE_QUERIES.map((query) => query.kind), [...ROI_WAREHOUSE_KINDS])
  const build = ROI_DATA_PULL_DATABRICKS.graph.nodes.find((node) => node.id === 'build')
  assert.ok(build && build.type === 'code')
  for (const kind of ROI_WAREHOUSE_KINDS) assert.ok(build.data.code.includes(`"kind":"${kind}"`), `the build step carries the ${kind} query`)
  const pull = ROI_DATA_PULL_DATABRICKS.graph.nodes.find((node) => node.id === 'pull')
  assert.ok(pull && pull.type === 'tool')
  assert.equal(pull.data.connectionId, 'native:roi')
  assert.ok(ROI_TOOLS.some((tool) => tool.name === pull.data.toolName && tool.isWrite), 'the pull tool is a write on the ROI plane')
  const args = JSON.parse(pull.data.args ?? '{}') as Record<string, string>
  const required = (ROI_TOOLS.find((tool) => tool.name === pull.data.toolName)?.inputSchema.required ?? []) as string[]
  for (const name of required) assert.ok(args[name], `the pull step passes ${name}`)
  assert.equal(pull.data.perItem?.over, '{{step.build.output}}')
})

test('the queries carry no org id of their own: it is substituted per run, digits only', () => {
  for (const query of ROI_WAREHOUSE_QUERIES) {
    assert.ok(query.sql.includes(ORG_ID_PLACEHOLDER), `${query.kind} is parameterised`)
    assert.doesNotMatch(query.sql, /200000303/, `${query.kind} has no hard-coded org id`)
    const filled = warehouseSql(query.sql, '4242')
    assert.ok(!filled.includes(ORG_ID_PLACEHOLDER) && filled.includes('4242'))
  }
  assert.match(ROI_WAREHOUSE_QUERIES.find((query) => query.kind === 'activity')!.sql, /org_4242\.|org___ORG_ID__\./)
  assert.throws(() => warehouseSql('select __ORG_ID__', "1 or 1=1"), /must be a number/)
})

test('installing it runs nothing: a manual trigger whose only required input is the account', () => {
  const trigger = ROI_DATA_PULL_DATABRICKS.graph.nodes.find((node) => node.type === 'trigger')
  assert.ok(trigger)
  const config = (trigger.data as { trigger: { type: string; inputFields: Array<{ name: string; required?: boolean }> } }).trigger
  assert.equal(config.type, 'manual')
  assert.deepEqual(config.inputFields.filter((field) => field.required).map((field) => field.name), ['account'])
  assert.deepEqual(ROI_DATA_PULL_DATABRICKS.bindings, [], 'no connection slot: the credential is the host-bound HTTP credential the setup names')
  assert.ok(ROI_DATA_PULL_DATABRICKS.notes.setup.some((step) => step.kind === 'integration' && /credential/i.test(step.label)))
})
