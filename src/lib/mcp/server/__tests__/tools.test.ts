import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeFlowTools,
  flowInputSchema,
  flowToolDescription,
  flowToolName,
  uniqueToolNames,
} from '@/lib/mcp/server/tools'

/**
 * These names and schemas travel into other people's clients — Claude, ChatGPT,
 * a customer's own agent — so they are a public contract in a way nothing else
 * in the builder is. A name that changes breaks a saved prompt somewhere we
 * cannot see.
 */

test('a tool is named after what it does, not after a row id', () => {
  assert.equal(flowToolName({ id: 'cmsjute6l0003l9048403qvmp', name: 'Send renewal brief' }), 'send_renewal_brief')
})

test('a name is reduced to what the protocol allows', () => {
  assert.equal(flowToolName({ id: 'c1', name: '  Weekly  Pipeline — Review! ' }), 'weekly_pipeline_review')
  assert.match(flowToolName({ id: 'c1', name: 'A/B test: 50% split' }), /^[a-z0-9_]+$/)
})

test('a flow whose name survives none of that still gets a callable name', () => {
  assert.equal(flowToolName({ id: 'cmsjute6l0003', name: '!!!' }), 'flow_cmsjute6l000')
  assert.equal(flowToolName({ id: 'cmsjute6l0003', name: '営業ブリーフ' }), 'flow_cmsjute6l000')
})

test('two flows with the same name get distinct tool names', () => {
  const names = uniqueToolNames([
    { id: 'aaaaaa111111', name: 'Daily brief' },
    { id: 'bbbbbb222222', name: 'Daily brief' },
  ])
  assert.equal(names.get('aaaaaa111111'), 'daily_brief')
  assert.equal(names.get('bbbbbb222222'), 'daily_brief_bbbbbb')
  assert.notEqual(names.get('aaaaaa111111'), names.get('bbbbbb222222'))
})

test('declared trigger inputs become named properties, required ones marked', () => {
  const schema = flowInputSchema({
    id: 'c1',
    name: 'Brief',
    trigger: {
      type: 'manual',
      inputFields: [
        { name: 'accountName', type: 'string', required: true, description: 'Which account' },
        { name: 'includeNews', type: 'boolean', default: 'true' },
      ],
    },
  })
  assert.deepEqual(schema.required, ['accountName'])
  assert.deepEqual(schema.properties.accountName, { type: 'string', description: 'Which account' })
  assert.deepEqual(schema.properties.includeNews, { type: 'boolean', default: 'true' })
})

test('a flow that declares no inputs still accepts one', () => {
  // It takes a run input; it just has no shape to advertise. Advertising
  // nothing would tell a calling model the flow cannot be given anything.
  const schema = flowInputSchema({ id: 'c1', name: 'Brief', trigger: { type: 'manual' } })
  assert.ok(schema.properties.input)
  assert.equal(schema.required, undefined)
})

test('a malformed trigger degrades to the free input rather than throwing', () => {
  for (const trigger of [null, undefined, 'manual', { inputFields: 'nope' }, { inputFields: [null, 42] }]) {
    const schema = flowInputSchema({ id: 'c1', name: 'Brief', trigger })
    assert.ok(schema.properties.input, JSON.stringify(trigger))
  }
})

test('a field with an unknown type is left untyped rather than guessed', () => {
  const schema = flowInputSchema({
    id: 'c1',
    name: 'Brief',
    trigger: { inputFields: [{ name: 'payload', type: 'any' }] },
  })
  assert.deepEqual(schema.properties.payload, {})
})

test('a flow with no description still tells the caller what it is', () => {
  assert.match(flowToolDescription({ id: 'c1', name: 'Daily brief' }), /Daily brief/)
  assert.equal(flowToolDescription({ id: 'c1', name: 'Daily brief', description: '  Sends it  ' }), 'Sends it')
})

test('the descriptor list is name-unique and protocol-legal throughout', () => {
  const tools = describeFlowTools([
    { id: 'aaaaaa111111', name: 'Daily brief' },
    { id: 'bbbbbb222222', name: 'Daily brief' },
    { id: 'cccccc333333', name: '!!!' },
  ])
  assert.equal(new Set(tools.map((tool) => tool.name)).size, 3)
  for (const tool of tools) {
    assert.match(tool.name, /^[a-z0-9_]+$/)
    assert.ok(tool.description.length > 0)
    assert.equal(tool.inputSchema.type, 'object')
  }
})
