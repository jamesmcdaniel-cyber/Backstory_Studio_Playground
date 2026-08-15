import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyToolPolicy, describeToolPolicy, isWriteToolName } from '../tool-policy'

/**
 * The property that must never break: a policy can only ever REMOVE tools.
 *
 * If narrowing could add, a flow author would have found an escalation path —
 * granting their step a tool the agent was never allowed. Every test here is
 * ultimately about that, plus not silently shrinking a tool set in a way that
 * gets debugged as a broken integration.
 */

const tools = [
  { name: 'get_account' },
  { name: 'search_records' },
  { name: 'send_email' },
  { name: 'create_task' },
  { name: 'summarize' },
]
const nameOf = (tool: { name: string }) => tool.name
const names = (result: { tools: Array<{ name: string }> }) => result.tools.map(nameOf).sort()

test('inherit is the default and changes nothing', () => {
  // Existing flows must be untouched: this shipped into a product full of them.
  assert.deepEqual(applyToolPolicy(tools, undefined, nameOf).tools, tools)
  assert.deepEqual(applyToolPolicy(tools, { mode: 'inherit' }, nameOf).tools, tools)
  assert.deepEqual(applyToolPolicy(tools, undefined, nameOf).removed, [])
})

test('readonly drops the tools that change things', () => {
  const result = applyToolPolicy(tools, { mode: 'readonly' }, nameOf)

  assert.deepEqual(names(result), ['get_account', 'search_records', 'summarize'])
  assert.deepEqual(result.removed.sort(), ['create_task', 'send_email'])
})

test('allowlist keeps only what was named', () => {
  const result = applyToolPolicy(tools, { mode: 'allowlist', allowedTools: ['get_account'] }, nameOf)
  assert.deepEqual(names(result), ['get_account'])
})

test('allowlist matches exactly — no prefix or fuzzy matching', () => {
  // `send` must NOT satisfy `send_email`. Fuzzy matching is the opposite of
  // what an allowlist is for, and it fails open.
  const result = applyToolPolicy(tools, { mode: 'allowlist', allowedTools: ['send'] }, nameOf)
  assert.deepEqual(result.tools, [])
})

test('an allowlist naming a tool the agent does not hold does NOT conjure it', () => {
  // The escalation this design exists to prevent.
  const result = applyToolPolicy(tools, { mode: 'allowlist', allowedTools: ['delete_everything'] }, nameOf)
  assert.deepEqual(result.tools, [])
})

test('an allowlist can never widen the set it was given', () => {
  const everyMode = ['readonly', 'allowlist', 'none'] as const
  for (const mode of everyMode) {
    const result = applyToolPolicy(tools, { mode, allowedTools: tools.map(nameOf).concat('phantom_tool') }, nameOf)
    assert.ok(result.tools.length <= tools.length, `${mode} must not add tools`)
    for (const tool of result.tools) {
      assert.ok(tools.includes(tool), `${mode} returned a tool that was not in the input`)
    }
  }
})

test('none removes everything, for a pure reasoning step', () => {
  const result = applyToolPolicy(tools, { mode: 'none' }, nameOf)
  assert.deepEqual(result.tools, [])
  assert.equal(result.removed.length, tools.length)
})

test('an allowlist with no entries yields no tools rather than all of them', () => {
  // Failing open here would make a misconfigured allowlist strictly worse than
  // no policy at all.
  assert.deepEqual(applyToolPolicy(tools, { mode: 'allowlist' }, nameOf).tools, [])
  assert.deepEqual(applyToolPolicy(tools, { mode: 'allowlist', allowedTools: [] }, nameOf).tools, [])
})

test('write detection covers the verbs tools actually use', () => {
  for (const name of ['send_email', 'create_task', 'delete_record', 'post_message', 'update_deal', 'archive_thread']) {
    assert.equal(isWriteToolName(name), true, `${name} should read as a write`)
  }
  for (const name of ['get_account', 'search_records', 'list_deals', 'find_contact', 'summarize']) {
    assert.equal(isWriteToolName(name), false, `${name} should read as a read`)
  }
})

test('a narrowing policy is described for the run log, never applied silently', () => {
  // An agent that mysteriously lacks a tool gets reported as a broken
  // integration and debugged for an hour.
  const result = applyToolPolicy(tools, { mode: 'readonly' }, nameOf)
  const note = describeToolPolicy(result, 'readonly')

  assert.ok(note)
  assert.match(note, /withheld 2 tool/)
  assert.match(note, /send_email|create_task/)
})

test('a policy that changed nothing produces no note', () => {
  // Noise in the run log costs attention that the real notes need.
  assert.equal(describeToolPolicy(applyToolPolicy(tools, undefined, nameOf), 'inherit'), null)
  assert.equal(
    describeToolPolicy(applyToolPolicy([{ name: 'get_account' }], { mode: 'readonly' }, nameOf), 'readonly'),
    null,
  )
})
