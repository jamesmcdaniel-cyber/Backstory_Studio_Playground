import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDataTree, fileBindingOptions, inferFields } from '../datatree'
import { httpOutputFields } from '../schema-fields'

test('inferFields walks objects and arrays into dot-path tokens', () => {
  const fields = inferFields({ score: 91, owner: { name: 'Ada' }, tags: ['a'] }, 'step.n1.output')
  const score = fields.find((f) => f.label === 'score')
  assert.equal(score?.token, '{{step.n1.output.score}}')
  assert.equal(score?.type, 'number')
  const owner = fields.find((f) => f.label === 'owner')
  assert.equal(owner?.children?.[0]?.token, '{{step.n1.output.owner.name}}')
  const tags = fields.find((f) => f.label === 'tags')
  assert.equal(tags?.children?.[0]?.token, '{{step.n1.output.tags.0}}')
})

test('buildDataTree offers trigger, declared fields, and inferred fields', () => {
  const tree = buildDataTree({
    trigger: true,
    upstream: [{ id: 'n1', label: 'Pull accounts', outputFields: [{ name: 'count', type: 'number' }] }],
    lastOutputs: { n1: { count: 5, region: 'EMEA' } },
  })
  assert.equal(tree[0].token, '{{trigger.input}}')
  const n1 = tree.find((r) => r.label === 'Pull accounts')
  const labels = n1?.children?.map((c) => c.label)
  assert.ok(labels?.includes('count')) // declared
  assert.ok(labels?.includes('region')) // inferred from last run
  // declared field is not duplicated by inference
  assert.equal(n1?.children?.filter((c) => c.label === 'count').length, 1)
})

test('buildDataTree infers fields from trigger input samples', () => {
  const tree = buildDataTree({
    upstream: [],
    triggerInput: { account: { name: 'Acme' }, items: ['A'] },
  })
  const trigger = tree.find((r) => r.token === '{{trigger.input}}')
  assert.equal(trigger?.type, 'object')
  assert.equal(trigger?.children?.find((field) => field.label === 'account')?.children?.[0]?.token, '{{trigger.input.account.name}}')
  assert.equal(trigger?.children?.find((field) => field.label === 'items')?.children?.[0]?.token, '{{trigger.input.items.0}}')
})

test('buildDataTree exposes declared trigger input fields before a sample run', () => {
  const tree = buildDataTree({
    upstream: [],
    inputFields: [
      { name: 'account', type: 'string', description: 'Customer account name.' },
      { name: 'priority', type: 'string' },
    ],
  })
  const trigger = tree.find((r) => r.token === '{{trigger.input}}')
  assert.equal(trigger?.children?.find((field) => field.label === 'account')?.token, '{{trigger.input.account}}')
  assert.equal(trigger?.children?.find((field) => field.label === 'account')?.description, 'Customer account name.')
  assert.equal(trigger?.children?.find((field) => field.label === 'priority')?.token, '{{trigger.input.priority}}')
})

test('buildDataTree exposes HTTP response fields before a sample run', () => {
  const tree = buildDataTree({
    upstream: [{ id: 'api', label: 'Fetch account', outputFields: httpOutputFields() }],
  })
  const api = tree.find((root) => root.label === 'Fetch account')
  assert.equal(api?.children?.find((field) => field.label === 'status')?.token, '{{step.api.output.status}}')
  assert.equal(api?.children?.find((field) => field.label === 'body')?.token, '{{step.api.output.body}}')
  assert.equal(api?.children?.find((field) => field.label === 'bodyText')?.type, 'string')
})

test('buildDataTree does not duplicate declared trigger fields inferred from a sample', () => {
  const tree = buildDataTree({
    upstream: [],
    inputFields: [{ name: 'account', type: 'string' }],
    triggerInput: { account: 'Acme', region: 'EMEA' },
  })
  const trigger = tree.find((r) => r.token === '{{trigger.input}}')
  assert.equal(trigger?.children?.filter((field) => field.label === 'account').length, 1)
  assert.ok(trigger?.children?.some((field) => field.label === 'region'))
})

test('buildDataTree exposes {{item}}/{{loop.index}} inside a loop', () => {
  const tree = buildDataTree({ upstream: [], insideLoop: true, lastOutputs: { __item: { name: 'Acme' } } })
  const item = tree.find((r) => r.token === '{{item}}')
  assert.ok(item)
  assert.equal(item?.children?.[0]?.token, '{{item.name}}')
  assert.ok(tree.some((r) => r.token === '{{loop.index}}'))
})

test('buildDataTree lists upstream initialized variables as typed {{var.*}} roots', () => {
  const tree = buildDataTree({
    upstream: [],
    variables: [
      { name: 'deal_count', type: 'integer' },
      { name: '', type: 'string' }, // blank names are skipped
    ],
  })
  const variable = tree.find((root) => root.token === '{{var.deal_count}}')
  assert.ok(variable)
  assert.equal(variable?.label, 'Variable deal_count')
  assert.equal(variable?.type, 'integer')
  assert.equal(variable?.description, 'Variable set earlier in this flow.')
  assert.equal(tree.filter((root) => root.token.startsWith('{{var.')).length, 1)
})

test('buildDataTree offers the Incoming data root when a step has upstream data, with fields from the direct upstream', () => {
  const tree = buildDataTree({
    upstream: [
      { id: 'n1', label: 'Fetch accounts' },
      { id: 'n2', label: 'Latest call' },
    ],
    // The direct upstream is the LAST entry; its observed output (an HTTP
    // envelope) feeds the children, unwrapped to the body like {{input}} reads.
    lastOutputs: { n2: { ok: true, status: 200, headers: {}, body: { userId: 7 }, bodyText: '{"userId":7}' } },
  })
  const incoming = tree.find((root) => root.token === '{{input}}')
  assert.ok(incoming, 'the Incoming data root exists')
  assert.equal(incoming?.label, 'Incoming data')
  assert.ok(incoming?.children?.some((child) => child.token === '{{input.userId}}'))
})

test('buildDataTree omits the Incoming data root on the first step', () => {
  const tree = buildDataTree({ upstream: [] })
  assert.equal(tree.find((root) => root.token === '{{input}}'), undefined)
})

test('fileBindingOptions offers pickable object paths and hides scalars and run context', () => {
  const tree = buildDataTree({
    trigger: false,
    upstream: [{ id: 'n1', label: 'Download invoice' }],
    lastOutputs: { n1: { fileId: 'f1', filename: 'invoice.pdf', mimeType: 'application/pdf', size: 4, url: '/api/files/f1' } },
  })
  const options = fileBindingOptions(tree)
  // Paths are stored bare — the UI shows the label, never token syntax.
  assert.ok(options.every((option) => !option.path.includes('{{')))
  assert.ok(options.some((option) => option.path === 'step.n1.output'))
  assert.ok(options.some((option) => option.label.includes('Download invoice')))
  // Scalars (filename, size) and the always-present run-context roots are out.
  assert.ok(!options.some((option) => option.path.endsWith('.filename')))
  assert.ok(!options.some((option) => /^(now|run|flow)/.test(option.path)))
})
