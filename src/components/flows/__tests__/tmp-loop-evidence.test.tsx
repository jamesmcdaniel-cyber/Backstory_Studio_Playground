import '@/test-support/jsdom-env'
import { test } from 'node:test'
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
win.ResizeObserver = RO
g.DOMMatrixReadOnly = DMRO
win.DOMMatrixReadOnly = DMRO
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

test('EVIDENCE: realistic parent — settle or spin?', async () => {
  const { GraphCanvas } = (await import('@/components/flows/canvas/graph-canvas')) as unknown as {
    GraphCanvas: (props: Record<string, unknown>) => React.ReactElement
  }

  let parentRenders = 0
  let selectionCalls = 0

  // Mirrors the page: selection state + the real canvasSelectionChange logic,
  // and the same inline-literal props the page passes.
  function Page({ status }: { status: Record<string, string> }) {
    parentRenders += 1
    if (parentRenders > 200) throw new Error(`RUNAWAY: parent rendered ${parentRenders} times`)
    const [selectedId, setSelectedId] = React.useState<string | null>(null)
    const [selectedIds, setSelectedIds] = React.useState<string[]>([])
    const [focusRequest, setFocusRequest] = React.useState<{ id: string; nonce: number } | null>(null)

    const onSelectionChange = React.useCallback((ids: string[]) => {
      selectionCalls += 1
      setSelectedIds(ids.length > 1 ? ids : [])
      setSelectedId(ids.length === 1 ? ids[0] : null)
    }, [])
    const onOpenNode = React.useCallback((nodeId: string) => {
      setSelectedId(nodeId)
      setSelectedIds([])
      setFocusRequest((prev) => ({ id: nodeId, nonce: (prev?.nonce ?? 0) + 1 }))
    }, [])

    return (
      <GraphCanvas
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

  const view = render(<Page status={{}} />)
  await act(async () => { await new Promise((r) => setTimeout(r, 200)) })
  console.log('parentRenders after mount:', parentRenders, 'selectionCalls:', selectionCalls)

  for (const s of ['running', 'succeeded']) {
    await act(async () => {
      view.rerender(<Page status={{ n2: s }} />)
      await new Promise((r) => setTimeout(r, 200))
    })
    console.log(`parentRenders after status=${s}:`, parentRenders, 'selectionCalls:', selectionCalls)
  }

  const nodeEl = view.container.querySelector('.react-flow__node')
  console.log('node rendered:', Boolean(nodeEl))
  if (nodeEl) {
    await act(async () => {
      nodeEl.dispatchEvent(new (win.MouseEvent as unknown as typeof MouseEvent)('dblclick', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 400))
    })
    console.log('parentRenders after open-node:', parentRenders, 'selectionCalls:', selectionCalls)
  }

  cleanup()
})
