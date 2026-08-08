import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { serializeFlow } from '@/lib/flows/serialize'

const flowRow = (graph: unknown, extra: Record<string, unknown> = {}) => ({
  id: 'f1',
  name: 'Demo',
  description: '',
  status: 'DRAFT',
  trigger: { type: 'manual' },
  graph,
  visibility: 'shared',
  userId: 'u1',
  organizationId: 'o1',
  version: 1,
  updatedAt: new Date(0),
  createdAt: new Date(0),
  folder: null,
  ...extra,
}) as never

describe('stepCount', () => {
  /**
   * The card read "1 step" for a pipeline of tool/http/data nodes, because the
   * count only ever included `agent` nodes — a rule left from when a flow WAS a
   * chain of agents.
   */
  it('counts every executable node, not just agent steps', () => {
    const graph = {
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        { id: 'pull', type: 'tool', data: { connectionId: 'c', toolName: 't' } },
        { id: 'score', type: 'ai', data: { aiOp: 'score', input: 'x' } },
        { id: 'shape', type: 'data', data: { op: 'compose', input: 'x' } },
        { id: 'out', type: 'output', data: { outputs: [] } },
      ],
      edges: [],
    }
    assert.equal((serializeFlow(flowRow(graph)) as { stepCount: number }).stepCount, 4)
  })

  it('excludes the trigger and canvas notes, which never execute', () => {
    const graph = {
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        { id: 'sticky', type: 'note', data: { text: 'annotation' } },
        { id: 'ask', type: 'ai', data: { aiOp: 'ask', input: 'x' } },
      ],
      edges: [],
    }
    assert.equal((serializeFlow(flowRow(graph)) as { stepCount: number }).stepCount, 1)
  })

  it('survives a malformed graph rather than throwing on the list page', () => {
    assert.equal((serializeFlow(flowRow(null)) as { stepCount: number }).stepCount, 0)
  })
})

describe('published', () => {
  const graph = { nodes: [{ id: 'trigger', type: 'trigger', data: {} }], edges: [] }

  it('is true once a published graph exists — the state that arms triggers', () => {
    const row = flowRow(graph, { publishedGraph: graph })
    assert.equal((serializeFlow(row) as { published: boolean }).published, true)
  })

  it('is false for a draft that has never been published', () => {
    assert.equal((serializeFlow(flowRow(graph)) as { published: boolean }).published, false)
  })
})

describe('icon', () => {
  const graph = { nodes: [], edges: [] }

  it('passes the stored emoji through to the wire shape', () => {
    assert.equal((serializeFlow(flowRow(graph, { icon: '📊' })) as { icon: string }).icon, '📊')
  })

  it('defaults to the empty string (generic glyph) for rows without one', () => {
    assert.equal((serializeFlow(flowRow(graph)) as { icon: string }).icon, '')
  })
})
