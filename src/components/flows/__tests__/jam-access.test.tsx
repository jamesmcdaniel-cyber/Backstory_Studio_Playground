import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen } from '@testing-library/react'
import { act } from 'react'
import { JamDialog } from '@/components/flows/jam-dialog'

/**
 * Workspace access is the OWNER's to change. A non-owner editor offered "Only
 * you" handed the flow to its owner and locked themselves (and the team) out —
 * the server now refuses it, so the chooser must not be offered either.
 */
const flush = async () => {
  await act(async () => { await Promise.resolve() })
}

globalThis.fetch = (async () => ({
  ok: true,
  json: async () => ({ success: true, selfId: 'me', members: [{ id: 'me', name: 'Me', email: 'me@x.test', role: 'USER' }] }),
})) as unknown as typeof fetch

const baseProps = {
  open: true as const,
  onOpenChange: () => {},
  flowId: 'f1',
  flowName: 'Flow',
  visibility: 'shared' as const,
  canEdit: true,
  onChangeVisibility: () => {},
}

afterEach(() => cleanup())

test('the owner gets the access chooser', async () => {
  render(<JamDialog {...baseProps} canChangeAccess />)
  await flush()
  assert.ok(screen.getByRole('button', { name: /^only you/i }))
})

test('a non-owner editor sees the current access, worded for them, and no chooser', async () => {
  render(<JamDialog {...baseProps} visibility="view" />)
  await flush()
  assert.equal(screen.queryByRole('button', { name: /^only you/i }), null)
  assert.equal(screen.queryByRole('button', { name: /everyone can edit/i }), null)
  assert.ok(screen.getByText(/only its owner makes changes/i), 'not "only you" — that is the owner')
  assert.ok(screen.getByText(/only its owner can change who can access this flow/i))
})
