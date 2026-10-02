import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { TemplatesView } from '../templates-view'

test('template cards do not wait for the roster or fail when skills fail', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async input => {
    const url = String(input)
    if (url === '/api/agents') return new Promise<Response>(() => {})
    if (url === '/api/skills') return Response.json({ error: 'offline' }, { status: 503 })
    if (url === '/api/agent-templates') return Response.json({ templates: [{ id: 'latency-test', name: 'Immediate template', description: 'Independent fetch', category: 'QA', tags: [] }] })
    return Response.json({})
  }) as typeof fetch
  const router = { push() {}, replace() {}, refresh() {}, prefetch: async () => {}, back() {}, forward() {} }
  try {
    render(<AppRouterContext.Provider value={router}><SearchParamsContext.Provider value={new URLSearchParams()}><TemplatesView /></SearchParamsContext.Provider></AppRouterContext.Provider>)
    assert.ok(await screen.findByText('Immediate template'))
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Skills/ }), { button: 0, ctrlKey: false })
    assert.ok(await screen.findByText('Could not load skills (503).'))
    fireEvent.click(screen.getByRole('button', { name: 'Templates' }))
    assert.ok(await screen.findByText('Immediate template'))
  } finally { cleanup(); globalThis.fetch = original }
})
