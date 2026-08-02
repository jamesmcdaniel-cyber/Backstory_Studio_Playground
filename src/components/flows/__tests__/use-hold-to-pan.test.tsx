import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React, { useRef } from 'react'
import { render, act, cleanup } from '@testing-library/react'
import { useHoldToPan } from '../canvas/use-hold-to-pan'

const HOLD_MS = 30
const win = () => (globalThis as unknown as { window: Window & typeof globalThis }).window

function pointer(type: string, x: number, y: number) {
  const e = new (win() as unknown as { Event: typeof Event }).Event(type, { bubbles: true, cancelable: true }) as unknown as Record<string, unknown>
  e.clientX = x; e.clientY = y; e.button = 0; e.pointerId = 1; e.isPrimary = true
  return e as unknown as PointerEvent
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function Harness({ panBy, onEngage }: { panBy: (d: { x: number; y: number }) => void; onEngage?: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useHoldToPan(ref, { enabled: true, panBy, onEngage, holdMs: HOLD_MS })
  return React.createElement(
    'div',
    { ref, 'data-testid': 'wrapper' },
    React.createElement('div', { className: 'react-flow__pane', 'data-testid': 'pane' }),
  )
}

function setup(panBy: (d: { x: number; y: number }) => void, onEngage?: () => void) {
  const view = render(React.createElement(Harness, { panBy, onEngage }))
  return {
    view,
    pane: view.container.querySelector('[data-testid="pane"]') as HTMLElement,
  }
}

test('holding still on empty canvas engages panning: moves pan and stop propagating', async (t) => {
  t.after(cleanup)
  const deltas: { x: number; y: number }[] = []
  let engaged = 0
  const { pane } = setup((d) => deltas.push(d), () => engaged++)

  const seenByPane: string[] = []
  pane.addEventListener('pointermove', () => seenByPane.push('move')) // stands in for React Flow's marquee handler

  act(() => { pane.dispatchEvent(pointer('pointerdown', 100, 100)) })
  await act(async () => { await sleep(HOLD_MS * 3) })
  act(() => { pane.dispatchEvent(pointer('pointermove', 130, 120)) })
  act(() => { pane.dispatchEvent(pointer('pointermove', 140, 110)) })

  assert.equal(engaged, 1)
  assert.deepEqual(deltas, [{ x: 30, y: 20 }, { x: 10, y: -10 }])
  assert.equal(seenByPane.length, 0, 'engaged moves must never reach the pane')
})

test('a quick drag (marquee) never engages: moves reach the pane, no panning', async (t) => {
  t.after(cleanup)
  const deltas: { x: number; y: number }[] = []
  const { pane } = setup((d) => deltas.push(d))

  const seenByPane: string[] = []
  pane.addEventListener('pointermove', () => seenByPane.push('move'))

  act(() => { pane.dispatchEvent(pointer('pointerdown', 100, 100)) })
  act(() => { pane.dispatchEvent(pointer('pointermove', 130, 100)) }) // moved past tolerance before the hold matured
  await act(async () => { await sleep(HOLD_MS * 3) })
  act(() => { pane.dispatchEvent(pointer('pointermove', 160, 100)) })

  assert.deepEqual(deltas, [])
  assert.equal(seenByPane.length, 2)
})

test('releasing a hold-pan swallows the click that follows; the next click passes', async (t) => {
  t.after(cleanup)
  const { pane } = setup(() => {})
  const clicks: string[] = []
  pane.addEventListener('click', () => clicks.push('click'))

  act(() => { pane.dispatchEvent(pointer('pointerdown', 100, 100)) })
  await act(async () => { await sleep(HOLD_MS * 3) })
  act(() => { pane.dispatchEvent(pointer('pointermove', 150, 100)) })
  act(() => { pane.dispatchEvent(pointer('pointerup', 150, 100)) })
  act(() => { pane.dispatchEvent(pointer('click', 150, 100)) })
  assert.deepEqual(clicks, [], 'the click ending a hold-pan must not deselect')

  act(() => { pane.dispatchEvent(pointer('pointerdown', 150, 100)) })
  act(() => { pane.dispatchEvent(pointer('pointerup', 150, 100)) })
  act(() => { pane.dispatchEvent(pointer('click', 150, 100)) })
  assert.deepEqual(clicks, ['click'], 'an ordinary click still goes through')
})

test('holding on a node (non-pane target) never engages', async (t) => {
  t.after(cleanup)
  const deltas: { x: number; y: number }[] = []
  const { view } = setup((d) => deltas.push(d))
  const wrapper = view.container.querySelector('[data-testid="wrapper"]') as HTMLElement
  const node = win().document.createElement('div')
  node.className = 'react-flow__node'
  wrapper.appendChild(node)

  act(() => { node.dispatchEvent(pointer('pointerdown', 100, 100)) })
  await act(async () => { await sleep(HOLD_MS * 3) })
  act(() => { node.dispatchEvent(pointer('pointermove', 150, 100)) })

  assert.deepEqual(deltas, [])
})
