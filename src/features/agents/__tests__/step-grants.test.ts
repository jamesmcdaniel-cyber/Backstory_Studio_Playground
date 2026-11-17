/**
 * A step's granted tool connections load exactly their own plane.
 *
 * Grant ids used to be split on ':' and the ref pushed into the agent's
 * provider list, where the registry's substring matchers read it: a provider
 * TOOL grant (`nango:github_list_repositories`) matched no Nango selector and
 * loaded nothing, while any grant with 'slack' in it switched on the built-in
 * Slack bot plane as well.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stepGrantSelection } from '../agent-tool-resolution'
import { BUILTIN_CONNECTORS } from '@/lib/connectors/registry'

test('a provider tool grant selects its provider, restricted to that one tool', () => {
  const selection = stepGrantSelection(['nango:github_list_repositories'])
  assert.deepEqual(selection.nango, { providers: ['nango:github'], connectionIds: ['nango:github_list_repositories'] })
  assert.deepEqual(selection.nativeSelectors, [])
  assert.deepEqual(selection.unknown, [])
})

test('a Nango Slack grant never reaches the built-in Slack bot plane', () => {
  for (const id of ['nango:slack', 'nango:slack_list_channels']) {
    const selection = stepGrantSelection([id])
    assert.deepEqual(selection.nativeSelectors, [], `${id} selects no built-in plane`)
    assert.deepEqual(selection.nango.providers, ['nango:slack'])
    assert.deepEqual(selection.nango.connectionIds, [id])
  }
})

test('a delivery capability grant selects that capability only', () => {
  const selection = stepGrantSelection(['nango:gmail'])
  assert.deepEqual(selection.nango, { providers: ['nango:gmail'], connectionIds: ['nango:gmail'] })
})

test('every built-in grant selects exactly its own built-in descriptor', () => {
  const builtins = BUILTIN_CONNECTORS.filter((c) => c.kind === 'builtin' && c.providerId !== 'artifact')
  for (const descriptor of builtins) {
    const { nativeSelectors, nango } = stepGrantSelection([`native:${descriptor.providerId}`])
    assert.equal(nango.connectionIds.length, 0)
    assert.equal(nativeSelectors.length, 1)
    const matched = builtins.filter((c) => nativeSelectors.some((s) => c.matches(s)))
    assert.deepEqual(matched.map((c) => c.providerId), [descriptor.providerId], `native:${descriptor.providerId} selects only itself`)
  }
})

test('a grant that names nothing is reported, and mcp/Sales AI grants need no selection', () => {
  const selection = stepGrantSelection(['nango:not_a_tool', 'native:nope', 'conn-row-id', 'people_ai:backstory'])
  assert.deepEqual(selection.unknown, ['nango:not_a_tool', 'native:nope'])
  assert.deepEqual(selection.nativeSelectors, [])
  assert.deepEqual(selection.nango.connectionIds, [])
})
