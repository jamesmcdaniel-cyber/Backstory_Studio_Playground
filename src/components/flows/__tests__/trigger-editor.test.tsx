/**
 * Coverage for the shared TriggerEditor extracted from step-drawer.tsx
 * (WS task 2): the webhook status panel auto-loads via GET
 * /api/flows/[id]/trigger-secret instead of requiring a manual mint, and the
 * arming copy at the panel footer reflects the flow's publish state.
 */
import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { TriggerEditor } from '../trigger-editor'

test('webhook panel auto-loads existing status: URL shown, secret-is-set state, no mint needed', async () => {
  const calls: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url))
    return { ok: true, json: async () => ({ success: true, hasSecret: true, url: 'https://app.example/api/flows/f1/trigger' }) }
  }) as unknown as typeof fetch
  try {
    render(React.createElement(TriggerEditor, { flowId: 'f1', trigger: { type: 'webhook' }, onChange: () => {}, published: true }))
    await screen.findByText('https://app.example/api/flows/f1/trigger')
    assert.ok(calls.some((u) => u.includes('/api/flows/f1/trigger-secret')))
    assert.ok(screen.getByText(/secret already exists|Secret is set/i))
    assert.ok(screen.getByText(/Armed — calls to this URL start a run/i))
  } finally {
    globalThis.fetch = realFetch
    cleanup()
  }
})

test('unpublished webhook flow shows publish-to-arm guidance', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    return { ok: true, json: async () => ({ success: true, hasSecret: true, url: 'https://app.example/api/flows/f1/trigger' }) }
  }) as unknown as typeof fetch
  try {
    render(React.createElement(TriggerEditor, { flowId: 'f1', trigger: { type: 'webhook' }, onChange: () => {}, published: false }))
    await screen.findByText('https://app.example/api/flows/f1/trigger')
    assert.ok(screen.getByText(/publish this flow to arm/i))
  } finally {
    globalThis.fetch = realFetch
    cleanup()
  }
})

test('webhook flow with no secret yet auto-mints one — no button click needed', async () => {
  const realFetch = globalThis.fetch
  const requests: { url: string; method: string }[] = []
  globalThis.fetch = (async (url: unknown, init?: { method?: string }) => {
    requests.push({ url: String(url), method: init?.method ?? 'GET' })
    return init?.method === 'POST'
      ? { ok: true, json: async () => ({ success: true, hasSecret: true, secret: 'auto-minted', url: 'https://app.example/api/flows/f1/trigger', updatedAt: '2026-08-02T12:00:00.000Z' }) }
      : { ok: true, json: async () => ({ success: true, hasSecret: false, url: 'https://app.example/api/flows/f1/trigger' }) }
  }) as unknown as typeof fetch
  try {
    render(React.createElement(TriggerEditor, { flowId: 'f1', trigger: { type: 'webhook' }, onChange: () => {}, published: true }))
    await screen.findByText('x-trigger-secret: auto-minted')
    assert.equal(requests.filter((r) => r.method === 'POST' && r.url.includes('/api/flows/f1/trigger-secret')).length, 1)
  } finally {
    globalThis.fetch = realFetch
    cleanup()
  }
})

test('the auto-minted webhook secret reports the persisted flow timestamp to the builder', async () => {
  const realFetch = globalThis.fetch
  const persisted: string[] = []
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return calls === 1
      ? { ok: true, json: async () => ({ success: true, hasSecret: false, url: 'https://app.example/api/flows/f1/trigger' }) }
      : { ok: true, json: async () => ({ success: true, hasSecret: true, secret: 'once', url: 'https://app.example/api/flows/f1/trigger', updatedAt: '2026-08-02T12:00:00.000Z' }) }
  }) as unknown as typeof fetch
  try {
    render(React.createElement(TriggerEditor, {
      flowId: 'f1',
      trigger: { type: 'webhook' },
      onChange: () => {},
      onPersisted: (updatedAt: string) => persisted.push(updatedAt),
    }))
    await screen.findByText('x-trigger-secret: once')
    assert.deepEqual(persisted, ['2026-08-02T12:00:00.000Z'])
  } finally {
    globalThis.fetch = realFetch
    cleanup()
  }
})

test('type picker writes through onChange', () => {
  const seen: { type?: string }[] = []
  render(React.createElement(TriggerEditor, { flowId: 'f1', trigger: { type: 'manual' }, onChange: (t: { type?: string }) => seen.push(t) }))
  const select = screen.getByLabelText(/trigger type/i)
  fireEvent.change(select, { target: { value: 'webhook' } })
  assert.equal(seen.at(-1)?.type, 'webhook')
  cleanup()
})

test('children slot renders where the drawer used to place InputFieldsEditor', () => {
  render(
    React.createElement(
      TriggerEditor,
      { flowId: 'f1', trigger: { type: 'manual' }, onChange: () => {} },
      React.createElement('div', { 'data-testid': 'input-fields-slot' }, 'slot content'),
    ),
  )
  assert.ok(screen.getByTestId('input-fields-slot'))
  cleanup()
})

test('classes prop overrides the default field class', () => {
  const { container } = render(
    React.createElement(TriggerEditor, {
      flowId: 'f1',
      trigger: { type: 'manual' },
      onChange: () => {},
      classes: { field: 'custom-field-class' },
    }),
  )
  const select = screen.getByLabelText(/trigger type/i)
  assert.ok(select.className.includes('custom-field-class'))
  assert.ok(!select.className.includes('w-full rounded-lg'))
  cleanup()
  void container
})

test('slack trigger panel: plain-English copy, no connected workspace yet', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).includes('/api/integrations/available')) {
      return { ok: true, json: async () => ({ success: true, tools: [{ key: 'Slack', label: 'Slack', slug: 'slack', connected: false }] }) }
    }
    return { ok: true, json: async () => ({ success: true }) }
  }) as unknown as typeof fetch
  try {
    render(React.createElement(TriggerEditor, { flowId: 'f1', trigger: { type: 'slack' }, onChange: () => {} }))
    await screen.findByText(/connect slack in/i)
    assert.ok(screen.getByText(/workspace credentials/i))
    assert.ok(screen.getByLabelText(/channel \(optional\)/i))
    assert.ok(screen.getByText(/only replies in threads/i))
    // Never a raw event code or a bracketed token anywhere in the panel.
    assert.ok(!document.body.textContent?.includes('{{'))
    assert.ok(!document.body.textContent?.includes('message.posted'))
  } finally {
    globalThis.fetch = realFetch
    cleanup()
  }
})

test('slack trigger panel: connected workspace hides the connect prompt', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).includes('/api/integrations/available')) {
      return { ok: true, json: async () => ({ success: true, tools: [{ key: 'Slack', label: 'Slack', slug: 'slack', connected: true }] }) }
    }
    return { ok: true, json: async () => ({ success: true }) }
  }) as unknown as typeof fetch
  try {
    render(React.createElement(TriggerEditor, { flowId: 'f1', trigger: { type: 'slack' }, onChange: () => {} }))
    await screen.findByLabelText(/channel \(optional\)/i)
    assert.equal(screen.queryByText(/connect slack in/i), null)
  } finally {
    globalThis.fetch = realFetch
    cleanup()
  }
})

test('activity trigger panel: plain-English source picker and event-type chips, no raw codes', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).includes('/api/integrations/available')) {
      return {
        ok: true,
        json: async () => ({
          success: true,
          tools: [
            { key: 'salesforce', label: 'Salesforce', slug: 'salesforce', connected: true },
            { key: 'Slack', label: 'Slack', slug: 'slack', connected: false },
          ],
        }),
      }
    }
    return { ok: true, json: async () => ({ success: true }) }
  }) as unknown as typeof fetch
  try {
    render(React.createElement(TriggerEditor, { flowId: 'f1', trigger: { type: 'activity' }, onChange: () => {} }))
    await screen.findByText('Salesforce')
    // Only the connected app shows up — the source list is honest, not aspirational.
    assert.equal(screen.queryByText('Slack'), null)
    assert.ok(screen.getByText('New message posted'))
    assert.ok(screen.getByText('Pull request opened'))
    assert.ok(screen.getByText('Other activity'))
    assert.ok(!document.body.textContent?.includes('message.posted'))
    assert.ok(!document.body.textContent?.includes('{{'))
  } finally {
    globalThis.fetch = realFetch
    cleanup()
  }
})

test('activity trigger: toggling an event-type chip writes through onChange', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ success: true, tools: [] }) })) as unknown as typeof fetch
  const seen: { kinds?: string[] }[] = []
  try {
    render(
      React.createElement(TriggerEditor, {
        flowId: 'f1',
        trigger: { type: 'activity' },
        onChange: (t: { kinds?: string[] }) => seen.push(t),
      }),
    )
    const chip = await screen.findByText('Record created')
    fireEvent.click(chip)
    assert.deepEqual(seen.at(-1)?.kinds, ['record.created'])
  } finally {
    globalThis.fetch = realFetch
    cleanup()
  }
})
