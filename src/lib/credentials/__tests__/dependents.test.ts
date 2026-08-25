import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  credentialRefKey,
  describeDependents,
  graphCredentialRefs,
  graphDependsOn,
  nodeCredentialRefs,
  rankDependents,
  type CredentialDependent,
} from '@/lib/credentials/dependents'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'

/**
 * The audit trail answers "who used this credential" after the fact. This
 * answers it BEFORE — which is the difference between revoking a connection and
 * discovering the blast radius when something breaks on a schedule at 6am.
 */

const httpNode = (id: string, data: Record<string, unknown>) =>
  ({ id, type: 'http', data: { method: 'GET', url: 'https://x.test', ...data } }) as unknown as FlowNode

const toolNode = (id: string, connectionId: string) =>
  ({ id, type: 'tool', data: { connectionId, toolName: 't', args: '{}' } }) as unknown as FlowNode

const graph = (nodes: FlowNode[]) => ({ nodes }) as Pick<FlowGraph, 'nodes'>

test('a step names the credentials it binds, by plane', () => {
  assert.deepEqual(nodeCredentialRefs(httpNode('a', { credentialId: 'cred_1' })), [
    { kind: 'http_credential', id: 'cred_1' },
  ])
  // An MCP connection is stored as its RAW row id — `mcp:` is not a prefix the
  // scheme uses (see PREFIXED_PLANES), so an unprefixed id is the MCP plane.
  assert.deepEqual(nodeCredentialRefs(toolNode('b', 'conn_1')), [{ kind: 'mcp_connection', id: 'conn_1' }])
  assert.deepEqual(nodeCredentialRefs(toolNode('c', 'nango:slack_post_message')), [
    { kind: 'nango', connectorKey: 'slack_post_message' },
  ])
})

test('a step that binds nothing names nothing', () => {
  assert.deepEqual(nodeCredentialRefs(httpNode('a', {})), [])
  assert.deepEqual(nodeCredentialRefs(httpNode('a', { credentialId: '   ' })), [])
})

test('a credential used inside a loop is found', () => {
  // A container holds its children as node IDS; the steps themselves sit in
  // graph.nodes alongside everything else. A Slack call inside a For-each is
  // exactly as broken by a revoked connection as one at the top level.
  const loop = { id: 'loop1', type: 'loop', data: { over: '{{x}}', body: ['inner'] } } as unknown as FlowNode
  const g = graph([loop, toolNode('inner', 'conn_1')])

  assert.deepEqual(graphCredentialRefs(g), [{ kind: 'mcp_connection', id: 'conn_1' }])
  assert.equal(graphDependsOn(g, { kind: 'mcp_connection', id: 'conn_1' }), true)
})

test('a credential inside a parallel branch is found', () => {
  const parallel = {
    id: 'par1',
    type: 'parallel',
    data: { branches: [['a'], ['b']] },
  } as unknown as FlowNode
  const g = graph([parallel, toolNode('a', 'nango:slack_post_message'), httpNode('b', { credentialId: 'cred_9' })])

  const refs = graphCredentialRefs(g).map(credentialRefKey).sort()
  assert.deepEqual(refs, ['http_credential:cred_9', 'nango:slack_post_message'])
})

test('the same credential used twice is reported once', () => {
  const refs = graphCredentialRefs(graph([toolNode('a', 'conn_1'), toolNode('b', 'conn_1')]))
  assert.equal(refs.length, 1)
})

test('a flow that does not use the credential says so', () => {
  assert.equal(graphDependsOn(graph([toolNode('a', 'other')]), { kind: 'mcp_connection', id: 'conn_1' }), false)
  assert.equal(graphDependsOn(graph([]), { kind: 'mcp_connection', id: 'conn_1' }), false)
})

test('published flows lead the list — they run with nobody watching', () => {
  const dependents: CredentialDependent[] = [
    { type: 'agent', id: 'a1', name: 'Zeta agent' },
    { type: 'flow', id: 'f1', name: 'Draft flow', published: false },
    { type: 'flow', id: 'f2', name: 'Live brief', published: true },
  ]
  assert.deepEqual(rankDependents(dependents).map((entry) => entry.id), ['f2', 'a1', 'f1'])
})

test('the warning leads with what is live', () => {
  const message = describeDependents([
    { type: 'flow', id: 'f2', name: 'Live brief', published: true },
    { type: 'flow', id: 'f1', name: 'Draft', published: false },
    { type: 'agent', id: 'a1', name: 'Agent' },
  ])
  assert.match(message, /1 published flow/)
  assert.match(message, /1 draft flow/)
  assert.match(message, /1 agent/)
  assert.match(message, /without anyone watching/)
})

test('nothing depending on it is stated plainly, not as an empty list', () => {
  assert.equal(describeDependents([]), 'Nothing uses this credential.')
})

test('a warning with no published flow does not claim something runs unwatched', () => {
  const message = describeDependents([{ type: 'agent', id: 'a1', name: 'Agent' }])
  assert.doesNotMatch(message, /without anyone watching/)
  assert.match(message, /^1 agent use/)
})
