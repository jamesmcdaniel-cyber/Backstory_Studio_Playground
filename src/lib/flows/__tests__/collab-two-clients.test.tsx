import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, act } from '@testing-library/react'
import { useFlowCollab } from '../use-flow-collab'
import { flowOpsTopic } from '../flow-channels'
import { FakeRealtime } from './support/fake-realtime'
import type { FlowGraph } from '../graph'

type Api = ReturnType<typeof useFlowCollab>
type Peer = { graph: FlowGraph; api?: Api }

const graph = (ids: string[]): FlowGraph => ({
  nodes: ids.map((id) => ({
    id,
    type: 'code' as const,
    position: { x: 0, y: 0 },
    data: { label: id, code: '' },
  })),
  edges: [],
}) as unknown as FlowGraph

/** The channel join awaits setAuth, so a couple of microtask turns are needed
 *  before peers are actually in the room. */
const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

function PeerView({ hub, name, canEdit, peer }: {
  hub: FakeRealtime
  name: string
  canEdit: boolean
  peer: Peer
}) {
  peer.api = useFlowCollab(
    'f1',
    { userId: name, name, canEdit },
    (next) => { peer.graph = next },
    () => peer.graph,
    { client: hub as never },
  )
  return null
}

function renderPair(hub: FakeRealtime, options?: { aCanEdit?: boolean }) {
  const a: Peer = { graph: graph(['n1']) }
  const b: Peer = { graph: graph(['n1']) }
  render(
    <>
      <PeerView hub={hub} name="a" canEdit={options?.aCanEdit ?? true} peer={a} />
      <PeerView hub={hub} name="b" canEdit peer={b} />
    </>,
  )
  return { a, b }
}

test('an edit by one peer reaches the other', async (t) => {
  t.after(cleanup)
  const hub = new FakeRealtime()
  const { a, b } = renderPair(hub)
  await settle()

  a.graph = graph(['n1', 'n2'])
  await act(async () => {
    a.api!.broadcastGraph(a.graph)
    await Promise.resolve()
  })

  assert.deepEqual(b.graph.nodes.map((n) => n.id).sort(), ['n1', 'n2'])
})

test('a view-only peer cannot push graph ops — the ops topic refuses the write', async (t) => {
  t.after(cleanup)
  const hub = new FakeRealtime()
  hub.denyWrite.add(flowOpsTopic('f1'))
  const { a, b } = renderPair(hub, { aCanEdit: false })
  await settle()

  a.graph = graph(['n1', 'injected'])
  await act(async () => {
    a.api!.broadcastGraph(a.graph)
    await Promise.resolve()
  })

  assert.deepEqual(b.graph.nodes.map((n) => n.id), ['n1'], 'the room never saw the injected node')
})

test('cursors from a peer arrive, carrying their view', async (t) => {
  t.after(cleanup)
  const hub = new FakeRealtime()
  const { a, b } = renderPair(hub)
  await settle()

  await act(async () => {
    a.api!.sendCursor(12, 34, 'canvas')
    await Promise.resolve()
  })

  const seen = b.api!.cursors
  assert.equal(seen.length, 1)
  assert.equal(seen[0].x, 12)
  assert.equal(seen[0].y, 34)
  assert.equal(seen[0].space, 'canvas')
})

test('presence lists the other person, with the view they are on', async (t) => {
  t.after(cleanup)
  const hub = new FakeRealtime()
  const { a, b } = renderPair(hub)
  await settle()
  await act(async () => {
    b.api!.setView('canvas')
    await Promise.resolve()
  })

  const others = a.api!.participants.filter((p) => p.clientId !== a.api!.selfClientId)
  assert.equal(others.length, 1)
  assert.equal(others[0].name, 'b')
  assert.equal(others[0].view, 'canvas')
})

test('a joiner is bootstrapped with the live, unsaved graph', async (t) => {
  t.after(cleanup)
  const hub = new FakeRealtime()
  const a: Peer = { graph: graph(['n1', 'unsaved']) }
  const view = render(<PeerView hub={hub} name="a" canEdit peer={a} />)
  await settle()

  // A second peer arrives holding only the persisted graph.
  const b: Peer = { graph: graph(['n1']) }
  view.rerender(
    <>
      <PeerView hub={hub} name="a" canEdit peer={a} />
      <PeerView hub={hub} name="b" canEdit peer={b} />
    </>,
  )
  await settle()

  assert.deepEqual(b.graph.nodes.map((n) => n.id).sort(), ['n1', 'unsaved'])
})

test('the bus delivers remote messages only', async (t) => {
  t.after(cleanup)
  const hub = new FakeRealtime()
  const { a, b } = renderPair(hub)
  await settle()

  const heardByB: Record<string, unknown>[] = []
  const heardByA: Record<string, unknown>[] = []
  a.api!.bus.on('drag', (payload) => heardByA.push(payload))
  b.api!.bus.on('drag', (payload) => heardByB.push(payload))

  await act(async () => {
    a.api!.bus.send('drag', { nodeId: 'n1', x: 5, y: 6 })
    await Promise.resolve()
  })

  assert.equal(heardByB.length, 1)
  assert.equal(heardByB[0].nodeId, 'n1')
  assert.equal(heardByA.length, 0, 'a sender never hears its own bus message')
})

test('a permission change is re-announced — stale canEdit would corrupt the persister election', async (t) => {
  t.after(cleanup)
  const hub = new FakeRealtime()
  const a: Peer = { graph: graph(['n1']) }
  const b: Peer = { graph: graph(['n1']) }
  // `a` joins believing it can edit (the builder's optimistic default), then
  // the flow loads and turns out to be view-only for them.
  const view = render(
    <>
      <PeerView hub={hub} name="a" canEdit peer={a} />
      <PeerView hub={hub} name="b" canEdit peer={b} />
    </>,
  )
  await settle()

  view.rerender(
    <>
      <PeerView hub={hub} name="a" canEdit={false} peer={a} />
      <PeerView hub={hub} name="b" canEdit peer={b} />
    </>,
  )
  await settle()

  const seenByB = b.api!.roster.find((p) => p.userId === 'a')
  assert.ok(seenByB, 'a is still in the room')
  assert.equal(seenByB.canEdit, false, 'the room must learn a is view-only')
})
