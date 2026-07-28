import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup } from '@testing-library/react'
import { act } from 'react'

const g = globalThis as unknown as Record<string, unknown>
const win = g.window as unknown as Record<string, { prototype: Record<string, unknown> }> & Record<string, unknown>

// React Flow measures the wrapper via ResizeObserver; report a real size so the
// viewport initializes and fitView actually moves it (jsdom has no layout).
class RO {
  cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) { this.cb = cb }
  observe(target: Element) {
    // Real ResizeObservers deliver asynchronously; delivering during observe()
    // would setState mid-render and spin for reasons unrelated to the bug.
    setTimeout(() => {
      this.cb(
        [{ target, contentRect: { width: 1200, height: 800, x: 0, y: 0, top: 0, left: 0, bottom: 800, right: 1200 } }] as unknown as ResizeObserverEntry[],
        this as unknown as ResizeObserver,
      )
    }, 0)
  }
  unobserve() {}
  disconnect() {}
}
class DMRO { m22 = 1; constructor(_t?: string) {} }
g.ResizeObserver = RO
win.ResizeObserver = RO as unknown as { prototype: Record<string, unknown> }
g.DOMMatrixReadOnly = DMRO
win.DOMMatrixReadOnly = DMRO as unknown as { prototype: Record<string, unknown> }
g.Element = win.Element
win.Element.prototype.scrollIntoView = () => {}
win.Element.prototype.getBoundingClientRect = function () {
  return { width: 200, height: 100, x: 0, y: 0, top: 0, left: 0, bottom: 100, right: 200, toJSON() {} }
} as unknown as () => DOMRect
Object.defineProperties(win.HTMLElement.prototype, {
  offsetHeight: { get() { return 100 } },
  offsetWidth: { get() { return 200 } },
})

import { createRequire } from 'node:module'
const req = createRequire(import.meta.url)
const Mod = req('module') as { _extensions: Record<string, unknown> }
Mod._extensions['.css'] = () => {}

import type { FlowGraph } from '@/lib/flows/graph'

const graph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
    { id: 'n2', type: 'http', data: { method: 'GET', url: 'https://example.com' } },
  ],
  edges: [{ id: 'e1', source: 'trigger', target: 'n2' }],
} as unknown as FlowGraph

/**
 * Opening a node used to spin forever: selection lives in three places at once
 * (React Flow's own store, the `selected` flag the node rebuild writes from
 * props, and the page state `onSelectionChange` feeds) and each write provoked
 * an echo the page adopted as if it were user intent —
 * selected → [] → selected → [] until React threw "Maximum update depth
 * exceeded" and the page hit its error boundary.
 *
 * The parent here mirrors the real page: same selection logic, same inline
 * literal props (so nothing is accidentally stabilized that isn't in prod).
 */
function harness() {
  let parentRenders = 0
  const selections: string[][] = []

  function Page({ status }: { status: Record<string, string> }) {
    parentRenders += 1
    if (parentRenders > 100) throw new Error(`RUNAWAY: parent rendered ${parentRenders} times`)
    const [selectedId, setSelectedId] = React.useState<string | null>(null)
    const [selectedIds, setSelectedIds] = React.useState<string[]>([])
    const [focusRequest, setFocusRequest] = React.useState<{ id: string; nonce: number } | null>(null)

    const onSelectionChange = React.useCallback((ids: string[]) => {
      selections.push(ids)
      setSelectedIds(ids.length > 1 ? ids : [])
      setSelectedId(ids.length === 1 ? ids[0] : null)
    }, [])
    const onOpenNode = React.useCallback((nodeId: string) => {
      setSelectedId(nodeId)
      setSelectedIds([])
      setFocusRequest((prev) => ({ id: nodeId, nonce: (prev?.nonce ?? 0) + 1 }))
    }, [])

    return (
      <GraphCanvasRef.current
        graph={graph}
        agentName={(id: string) => id}
        agents={[]}
        toolCatalog={[]}
        labelCtx={{ stepLabels: {} }}
        published={[]}
        statusByNode={status}
        issuesByNode={undefined}
        highlightIds={selectedIds.length > 1 ? selectedIds : []}
        selectedId={selectedId}
        selectedIds={selectedIds}
        remoteSelections={undefined}
        cursors={[]}
        focusRequest={focusRequest}
        readOnly={false}
        onSelectionChange={onSelectionChange}
        onOpenNode={onOpenNode}
        onMoveNodes={() => {}}
        onConnectNodes={() => {}}
        onDeleteEdge={() => {}}
        onInsertFromHandle={() => {}}
        onInsertOnEdge={() => {}}
        onTidyUp={() => {}}
        onCopySelection={() => {}}
        onPasteAt={() => {}}
        onCursorMove={() => {}}
      />
    )
  }

  return { Page, renders: () => parentRenders, selections }
}

const GraphCanvasRef = { current: (() => null) as unknown as (props: Record<string, unknown>) => React.ReactElement }

test('opening a node settles instead of spinning the selection feedback loop', async () => {
  const mod = (await import('@/components/flows/canvas/graph-canvas')) as unknown as {
    GraphCanvas: (props: Record<string, unknown>) => React.ReactElement
  }
  GraphCanvasRef.current = mod.GraphCanvas

  const { Page, renders, selections } = harness()
  const view = render(<Page status={{}} />)
  await act(async () => { await new Promise((r) => setTimeout(r, 200)) })

  const nodeEl = view.container.querySelector('.react-flow__node')
  assert.ok(nodeEl, 'expected a node to render')

  const before = renders()
  await act(async () => {
    nodeEl.dispatchEvent(new (win.MouseEvent as unknown as typeof MouseEvent)('dblclick', { bubbles: true }))
    // Longer than the 300ms fitView animation, so any viewport-driven
    // re-render storm has time to show up rather than being missed.
    await new Promise((r) => setTimeout(r, 600))
  })

  const after = renders()
  assert.ok(
    after - before <= 6,
    `opening a node should settle in a few renders, took ${after - before}. Selection echoes: ${JSON.stringify(selections)}`,
  )

  cleanup()
})

// The reported repro: a step is open while a test run streams statuses in, so
// the rebuild (driven by status) and the selection writer are both active.
test('statuses streaming in while a node is open neither spin nor drop the selection', async () => {
  const mod = (await import('@/components/flows/canvas/graph-canvas')) as unknown as {
    GraphCanvas: (props: Record<string, unknown>) => React.ReactElement
  }
  GraphCanvasRef.current = mod.GraphCanvas

  const { Page, renders } = harness()
  const view = render(<Page status={{}} />)
  await act(async () => { await new Promise((r) => setTimeout(r, 200)) })

  const nodeEl = view.container.querySelector('.react-flow__node')
  await act(async () => {
    nodeEl!.dispatchEvent(new (win.MouseEvent as unknown as typeof MouseEvent)('dblclick', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 400))
  })

  for (const status of ['running', 'succeeded']) {
    const before = renders()
    await act(async () => {
      view.rerender(<Page status={{ n2: status }} />)
      await new Promise((r) => setTimeout(r, 200))
    })
    assert.ok(renders() - before <= 4, `status=${status} with a node open should settle, took ${renders() - before}`)
  }

  // The rebuild that status changes trigger must carry selection through it.
  assert.ok(
    view.container.querySelector('.react-flow__node.selected'),
    'the open node should still be selected after statuses stream in',
  )

  cleanup()
})

test('run status updates settle without re-rendering the page in a loop', async () => {
  const mod = (await import('@/components/flows/canvas/graph-canvas')) as unknown as {
    GraphCanvas: (props: Record<string, unknown>) => React.ReactElement
  }
  GraphCanvasRef.current = mod.GraphCanvas

  const { Page, renders } = harness()
  const view = render(<Page status={{}} />)
  await act(async () => { await new Promise((r) => setTimeout(r, 200)) })

  for (const status of ['running', 'succeeded']) {
    const before = renders()
    await act(async () => {
      view.rerender(<Page status={{ n2: status }} />)
      await new Promise((r) => setTimeout(r, 200))
    })
    assert.ok(renders() - before <= 3, `status=${status} should settle, took ${renders() - before} renders`)
  }

  cleanup()
})
