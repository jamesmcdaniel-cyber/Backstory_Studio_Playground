import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { serializeFlow } from '@/lib/flows/serialize'
import { stepCountOf, isExecutableNode } from '@/lib/flows/graph'
import { stepCountOf as templateStepCountOf } from '@/lib/flows/templates/catalogue'
import { applyAlwaysOutputData } from '@/lib/flows/keep-alive'

/**
 * The publish → run → card path, as one test.
 *
 * Each piece was covered separately, which is exactly how a status regression
 * slipped through: publishing set ACTIVE, the card read DRAFT, and nothing
 * asserted that the two agreed.
 */

const graph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: {} },
    { id: 'pull', type: 'tool', data: { connectionId: 'c1', toolName: 'top_records' } },
    { id: 'shape', type: 'data', data: { op: 'compose', input: '{{step.pull.output}}' } },
    { id: 'note', type: 'note', data: { text: 'annotation' } },
  ],
  edges: [{ id: 'e0', source: 'trigger', target: 'pull' }],
}

const row = (extra: Record<string, unknown> = {}) => ({
  id: 'f1',
  name: 'Sales AI Upsell Engine Demo',
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

describe('a flow as the card sees it', () => {
  it('reports every executable step, so a tool pipeline is not shown as one step', () => {
    const card = serializeFlow(row()) as { stepCount: number }
    assert.equal(card.stepCount, 2, 'trigger and canvas note are not steps; tool and data are')
  })

  it('reads as published the moment a published graph exists', () => {
    const draft = serializeFlow(row()) as { published: boolean }
    const live = serializeFlow(row({ publishedGraph: graph, status: 'ACTIVE' })) as { published: boolean; status: string }
    assert.equal(draft.published, false)
    assert.equal(live.published, true)
    assert.equal(live.status, 'active', 'publish arms the flow; the card must not still say draft')
  })

  it('never reports published-but-inactive, which would be a flow that cannot be triggered', () => {
    // publish/unpublish own both fields together. If a published flow could sit
    // at DRAFT, its triggers would be disarmed while the card said otherwise —
    // the exact confusion this suite exists to prevent.
    const live = serializeFlow(row({ publishedGraph: graph, status: 'ACTIVE' })) as { published: boolean; status: string }
    assert.ok(!(live.published && live.status === 'draft'))
  })
})

describe('one definition of a step', () => {
  it('is shared by the flows list and the template catalogue', () => {
    assert.equal(stepCountOf(graph), templateStepCountOf(graph as never))
    assert.equal(stepCountOf(graph), (serializeFlow(row()) as { stepCount: number }).stepCount)
  })

  it('excludes exactly the nodes that never execute', () => {
    assert.equal(isExecutableNode({ type: 'trigger' }), false)
    assert.equal(isExecutableNode({ type: 'note' }), false)
    for (const type of ['tool', 'http', 'agent', 'ai', 'data', 'code', 'output']) {
      assert.equal(isExecutableNode({ type }), true, `${type} is a step`)
    }
  })
})

describe('always output data', () => {
  it('substitutes an empty result so the branch below still runs', () => {
    assert.deepEqual(applyAlwaysOutputData({ output: undefined }, true), { output: {} })
    assert.deepEqual(applyAlwaysOutputData({ output: null }, true), { output: {} })
  })

  it('leaves a real result alone, including falsy ones', () => {
    assert.deepEqual(applyAlwaysOutputData({ output: 0 }, true), { output: 0 })
    assert.deepEqual(applyAlwaysOutputData({ output: '' }, true), { output: '' })
    assert.deepEqual(applyAlwaysOutputData({ output: false }, true), { output: false })
  })

  it('is off unless explicitly enabled, and never invents output for a failure', () => {
    assert.deepEqual(applyAlwaysOutputData({ output: undefined }, undefined), { output: undefined })
    assert.deepEqual(applyAlwaysOutputData({ output: null }, false), { output: null })
    assert.deepEqual(applyAlwaysOutputData({ error: 'boom' } as never, true), { error: 'boom' })
  })
})
