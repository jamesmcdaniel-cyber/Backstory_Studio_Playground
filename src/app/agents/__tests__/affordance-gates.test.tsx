import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { act } from 'react'
import { RosterCard } from '../roster-card'
import { HttpCredentialsPanel } from '../agent-config-form'

/**
 * The agents UI offers only what the routes will allow THIS viewer. A member
 * hit "You do not have permission to do that." because a button the route
 * refused was shown anyway; these pin the gates at the components. (The
 * gallery's choices are agentActions, pinned in lib/agents viewer-gates — it
 * can't be rendered here: it imports the sidebar, which needs Supabase env.)
 */
const flush = async () => {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

afterEach(() => cleanup())

const stats = { runs: 0, completed: 0, failed: 0, blocked: 0, approximateRuns: 0 }

test('a roster card draws no settings button for a viewer who cannot configure it', () => {
  render(<RosterCard seed="a1" name="Watcher" role={null} roleLoading={false} presence="ready" stats={stats} onOpen={() => {}} configureLabel="Configure Watcher" />)
  assert.equal(screen.queryByRole('button', { name: 'Configure Watcher' }), null)
})

const stubFetch = (handler: (url: string, init?: RequestInit) => unknown) => {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = handler(String(url), init) ?? {}
    return { ok: true, status: 200, json: async () => body }
  }) as unknown as typeof fetch
}

test('the API credentials panel offers Test and Delete only on rows the viewer manages, and says delete is workspace-wide', async () => {
  stubFetch(() => ({
    success: true,
    credentials: [
      { id: 'mine', name: 'My key', authType: 'bearer', allowedHost: 'api.mine.test', status: 'verified', lastVerifiedAt: null, lastError: null, canManage: true },
      { id: 'legacy', name: 'Old shared key', authType: 'bearer', allowedHost: 'api.old.test', status: 'verified', lastVerifiedAt: null, lastError: null, canManage: false, isSharedLegacy: true },
    ],
  }))
  render(<HttpCredentialsPanel active />)
  await flush()
  assert.equal(screen.getAllByRole('button', { name: /^test$/i }).length, 1)
  assert.equal(screen.queryByRole('button', { name: /delete credential old shared key/i }), null)
  assert.ok(screen.getByText(/admins manage/i))

  fireEvent.click(screen.getByRole('button', { name: /delete credential my key \(all agents & flows\)/i }))
  await flush()
  assert.ok(screen.getByText(/deletes the credential for the whole workspace, not just this agent/i))
})
