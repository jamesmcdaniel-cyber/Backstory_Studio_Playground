import test from 'node:test'
import assert from 'node:assert/strict'
import {
  blockedToolMessage,
  humanizeToolName,
  mergeToolPolicies,
  readToolAnnotations,
  readToolPolicies,
  toolPolicyFor,
} from '../tool-policy'
import { computeToolSchemaHash } from '../verify-connection'

test('a tool that is not in the map is allowed — new server tools work by default', () => {
  assert.equal(toolPolicyFor({}, 'brand_new_tool'), 'allow')
  assert.equal(toolPolicyFor({ a: 'off', b: 'approve' }, 'a'), 'off')
  assert.equal(toolPolicyFor({ a: 'off', b: 'approve' }, 'b'), 'approve')
  // An inherited Object.prototype key is not a stored policy.
  assert.equal(toolPolicyFor({}, 'constructor'), 'allow')
})

test('the stored map is read defensively: unknown values and shapes fall back to allowed', () => {
  assert.deepEqual(readToolPolicies(null), {})
  assert.deepEqual(readToolPolicies([]), {})
  assert.deepEqual(readToolPolicies('off'), {})
  assert.deepEqual(readToolPolicies({ a: 'off', b: 'approve', c: 'allow', d: true, e: 'OFF' }), { a: 'off', b: 'approve' })
})

test('merging stores only approve/off and lets "allow" remove the entry', () => {
  const merged = mergeToolPolicies({ a: 'off', b: 'approve' }, { a: 'allow', c: 'off', b: 'approve' })
  assert.deepEqual(merged, { b: 'approve', c: 'off' })
  // The input is not mutated (the route compares before and after).
  const before = { a: 'off' as const }
  mergeToolPolicies(before, { a: 'allow' })
  assert.deepEqual(before, { a: 'off' })
})

test('tool names read as sentences', () => {
  assert.equal(humanizeToolName('account_company_news'), 'Account company news')
  assert.equal(humanizeToolName('getOpportunityStatus'), 'Get opportunity status')
  assert.equal(humanizeToolName('find-record.by_crm_id'), 'Find record by crm id')
  assert.equal(humanizeToolName('___'), '___')
})

test('the refusal names the tool, the server and where to change it', () => {
  assert.equal(blockedToolMessage('fetch_records', 'Backstory'), 'fetch_records is turned off for Backstory in Integrations')
})

test('annotations keep only the spec fields, with the spec types', () => {
  assert.equal(readToolAnnotations(undefined), undefined)
  assert.equal(readToolAnnotations({ readOnlyHint: 'yes' }), undefined)
  assert.deepEqual(readToolAnnotations({ readOnlyHint: true, destructiveHint: false, extra: 1, title: '  Find  ' }), { title: 'Find', readOnlyHint: true, destructiveHint: false })
})

test('the schema hash covers name and schemas only — permissions and display hints never read as drift', () => {
  const tools = [
    { name: 'b', inputSchema: { type: 'object' } },
    { name: 'a', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
  ]
  const base = computeToolSchemaHash(tools)
  const decorated = tools.map((tool) => ({ ...tool, title: tool.name.toUpperCase(), annotations: { readOnlyHint: true }, policy: 'off' }))
  assert.equal(computeToolSchemaHash(decorated), base)
  assert.equal(computeToolSchemaHash([...tools].reverse()), base, 'order-independent')
  assert.notEqual(computeToolSchemaHash(tools.slice(1)), base, 'a tool leaving the SERVER is still drift')
})
