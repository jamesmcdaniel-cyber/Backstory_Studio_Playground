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
 * The trigger's drawer must open on a completed CLICK, never on selection.
 * React Flow selects a node on mousedown — the first event of a drag — so a
 * drawer hung off `onSelectionChange` opens mid-drag and swallows the move
 * gesture. That was the bug: the trigger could not be dragged because pressing
 * it opened its configuration drawer.
 *
 * `onNodeClick` is the safe hook: React Flow fires it only when the pointer
 * did not travel past nodeDragThreshold, so real drags never trigger it.
 */
async function mount() {
  const mod = (await import('@/components/flows/canvas/graph-canvas')) as unknown as {
    GraphCanvas: (props: Record<string, unknown>) => React.ReactElement
  }
  const clicks: string[] = []
  const selections: string[][] = []

  function Page() {
    const [selectedId, setSelectedId] = React.useState<string | null>(null)
    const [selectedIds, setSelectedIds] = React.useState<string[]>([])
    const onSelectionChange = React.useCallback((ids: string[]) => {
      selections.push(ids)
      setSelectedIds(ids.length > 1 ? ids : [])
      setSelectedId(ids.length === 1 ? ids[0] : null)
    }, [])
    return (
      <mod.GraphCanvas
        graph={graph}
        agentName={(id: string) => id}
        agents={[]}
        toolCatalog={[]}
        labelCtx={{ stepLabels: {} }}
        published={[]}
        statusByNode={{}}
        issuesByNode={undefined}
        highlightIds={[]}
        selectedId={selectedId}
        selectedIds={selectedIds}
        remoteSelections={undefined}
        cursors={[]}
        focusRequest={null}
        readOnly={false}
        onSelectionChange={onSelectionChange}
        onNodeClick={(nodeId: string) => clicks.push(nodeId)}
        onOpenNode={() => {}}
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

  const view = render(<Page />)
  await act(async () => { await new Promise((r) => setTimeout(r, 200)) })
  return { view, clicks, selections }
}

const mouse = (type: string, init?: MouseEventInit) =>
  new (win.MouseEvent as unknown as typeof MouseEvent)(type, { bubbles: true, ...init })

test('pressing a node (drag start) does not fire onNodeClick', async () => {
  const { view, clicks } = await mount()
  const nodeEl = view.container.querySelector('.react-flow__node')
  assert.ok(nodeEl, 'expected a node to render')

  await act(async () => {
    nodeEl.dispatchEvent(mouse('mousedown', { button: 0 }))
    await new Promise((r) => setTimeout(r, 50))
  })

  assert.deepEqual(clicks, [], 'mousedown alone must not count as a click — it is how every drag begins')
  cleanup()
})

test('a completed click on the trigger fires onNodeClick with its id', async () => {
  const { view, clicks } = await mount()
  const nodeEl = view.container.querySelector('.react-flow__node')
  assert.ok(nodeEl, 'expected a node to render')

  await act(async () => {
    nodeEl.dispatchEvent(mouse('click', { button: 0 }))
    await new Promise((r) => setTimeout(r, 50))
  })

  assert.deepEqual(clicks, ['trigger'], 'click should surface through the onNodeClick prop')
  cleanup()
})
