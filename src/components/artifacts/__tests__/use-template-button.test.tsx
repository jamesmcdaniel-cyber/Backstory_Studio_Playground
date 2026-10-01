import '@/test-support/jsdom-env'
import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import { UseTemplateButton } from '../use-template-button'

test('viewing a template never creates a copy; an explicit click POSTs and failures are recoverable', async () => {
  const original = globalThis.fetch
  const calls: Array<{ url: string; method?: string }> = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method })
    return Response.json({ error: 'Template no longer shared' }, { status: 404 })
  }
  try {
    const ui = render(<UseTemplateButton token="test-token" />)
    assert.equal(calls.length, 0)
    await act(async () => { fireEvent.click(ui.getByRole('button', { name: 'Use template with AI Copilot' })) })
    assert.deepEqual(calls, [{ url: '/api/share/artifacts/test-token/copy', method: 'POST' }])
    assert.equal(ui.getByRole('alert').textContent, 'Template no longer shared')
    assert.equal((ui.getByRole('button') as HTMLButtonElement).disabled, false)
  } finally { cleanup(); globalThis.fetch = original }
})
