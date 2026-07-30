import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, act } from '@testing-library/react'

const g = globalThis as unknown as Record<string, unknown>
const win = g.window as unknown as Record<string, { prototype: Record<string, unknown> }> & Record<string, unknown>

// React Flow measures the wrapper via ResizeObserver; report a real size so the
// viewport initializes (jsdom has no layout).
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
import type { DragPreview } from '@/lib/flows/drag-preview'

const graph = {
  nodes: [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: { type: 'manual' } } },
    { id: 'n2', type: 'http', position: { x: 0, y: 200 }, data: { method: 'GET', url: 'https://example.com' } },
  ],
  edges: [{ id: 'e1', source: 'trigger', target: 'n2' }],
} as unknown as FlowGraph

const GraphCanvasRef = { current: (() => null) as unknown as (props: Record<string, unknown>) => React.ReactElement }

function Page({ dragPreview }: { dragPreview: DragPreview }) {
  return (
    <GraphCanvasRef.current
      graph={graph}
      agentName={(id: string) => id}
      agents={[]}
      toolCatalog={[]}
      labelCtx={{ stepLabels: {} }}
      published={[]}
      statusByNode={{}}
      issuesByNode={undefined}
      highlightIds={[]}
      selectedId={null}
      selectedIds={[]}
      remoteSelections={undefined}
      cursors={[]}
      dragPreview={dragPreview}
      focusRequest={null}
      readOnly={false}
      onSelectionChange={() => {}}
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
      onNodeDrag={() => {}}
    />
  )
}

const settle = async (ms = 250) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)) }) }
const positionOf = (view: { container: Element }, id: string) => {
  const el = view.container.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement | null
  return el?.style.transform ?? null
}

test("a teammate's in-flight drag moves their node on our canvas", async (t) => {
  t.after(cleanup)
  const mod = (await import('@/components/flows/canvas/graph-canvas')) as unknown as {
    GraphCanvas: (props: Record<string, unknown>) => React.ReactElement
  }
  GraphCanvasRef.current = mod.GraphCanvas

  const view = render(<Page dragPreview={{}} />)
  await settle()
  const before = positionOf(view, 'n2')
  assert.ok(before, 'expected the node to render')

  view.rerender(<Page dragPreview={{ n2: { x: 640, y: 480, ts: Date.now() } }} />)
  await settle(100)

  const after = positionOf(view, 'n2')
  assert.notEqual(after, before, 'the preview should move the node')
  assert.match(String(after), /640px,\s*480px/, `expected the previewed position, got ${after}`)
})

test('a preview for an unknown node changes nothing', async (t) => {
  t.after(cleanup)
  const mod = (await import('@/components/flows/canvas/graph-canvas')) as unknown as {
    GraphCanvas: (props: Record<string, unknown>) => React.ReactElement
  }
  GraphCanvasRef.current = mod.GraphCanvas

  const view = render(<Page dragPreview={{}} />)
  await settle()
  const before = positionOf(view, 'n2')

  view.rerender(<Page dragPreview={{ ghost: { x: 999, y: 999, ts: Date.now() } }} />)
  await settle(100)

  assert.equal(positionOf(view, 'n2'), before)
})
