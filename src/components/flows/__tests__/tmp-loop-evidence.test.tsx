import '@/test-support/jsdom-env'
import { test } from 'node:test'
import React from 'react'
import { render, cleanup } from '@testing-library/react'
import { act } from 'react-dom/test-utils'

// ── React Flow needs these; jsdom has none of them ──────────────────────────
const g = globalThis as unknown as Record<string, unknown>
class RO {
  callback: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) { this.callback = cb }
  observe() { /* no layout in jsdom */ }
  unobserve() {}
  disconnect() {}
}
g.ResizeObserver = RO
class DMRO {
  m22 = 1
  constructor(_t?: string) {}
}
g.DOMMatrixReadOnly = DMRO
g.DOMMatrix = DMRO
const win = g.window as unknown as Record<string, { prototype: Record<string, unknown> }>
g.Element = win.Element
win.Element.prototype.scrollIntoView = () => {}
Object.defineProperties(win.HTMLElement.prototype, {
  offsetHeight: { get() { return 100 } },
  offsetWidth: { get() { return 200 } },
})
;(g.window as unknown as Record<string, unknown>).ResizeObserver = RO
;(g.window as unknown as Record<string, unknown>).DOMMatrixReadOnly = DMRO

// Node can't parse the .css React Flow imports — make it a no-op module.
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

test('EVIDENCE: does the canvas settle or spin?', async () => {
  const { GraphCanvas } = (await import('@/components/flows/canvas/graph-canvas')) as unknown as {
    GraphCanvas: (props: Record<string, unknown>) => React.ReactElement
  }
  let renders = 0
  const Probe = (props: Record<string, unknown>) => {
    renders += 1
    return <GraphCanvas {...props} />
  }

  const baseProps = {
    graph,
    agentName: (id: string) => id,
    agents: [],
    toolCatalog: [],
    labelCtx: { stepLabels: {} },
    published: [],
    statusByNode: {},
    issuesByNode: undefined,
    highlightIds: [] as string[],
    selectedId: null,
    selectedIds: [] as string[],
    remoteSelections: undefined,
    cursors: [],
    focusRequest: null,
    readOnly: false,
    onSelectionChange: () => {},
    onOpenNode: () => {},
    onMoveNodes: () => {},
    onConnectNodes: () => {},
    onDeleteEdge: () => {},
    onInsertFromHandle: () => {},
    onInsertOnEdge: () => {},
    onTidyUp: () => {},
    onCopySelection: () => {},
    onPasteAt: () => {},
    onCursorMove: () => {},
  }

  const view = render(<Probe {...baseProps} />)
  await act(async () => { await new Promise((r) => setTimeout(r, 100)) })
  console.log('renders after mount:', renders)

  // Simulate what "running a flow" does: stream a new statusByNode object.
  for (const status of ['running', 'succeeded']) {
    await act(async () => {
      view.rerender(<Probe {...baseProps} statusByNode={{ n2: status }} />)
      await new Promise((r) => setTimeout(r, 50))
    })
    console.log(`renders after status=${status}:`, renders)
  }

  cleanup()
})
