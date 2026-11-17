/**
 * The HTTP step offers credential actions only to someone the routes will let
 * act: "Make per-user" needs an integration admin (RESOLVER_ADMIN_REQUIRED),
 * "Re-verify" needs the credential's owner or an admin (the PATCH refuses
 * anyone else), and a step bound to a teammate's credential — one this viewer
 * can't even list — must not be presented as "Verified".
 */
import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen } from '@testing-library/react'
import { act } from 'react'
import { StepDrawer } from '../step-drawer'
import type { FlowNode } from '@/lib/flows/graph'

const flush = async () => {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}

const credential = (overrides: Record<string, unknown> = {}) => ({
  id: 'mine', name: 'My key', authType: 'bearer', allowedHost: 'api.test', status: 'verified',
  lastVerifiedAt: null, lastError: null, userId: 'me', isSharedLegacy: false, canManage: true,
  ...overrides,
})

function stub({ credentials, canCreate }: { credentials: unknown[]; canCreate: boolean }) {
  globalThis.fetch = (async (url: string) => ({
    ok: true,
    json: async () => (String(url).includes('credential-resolvers')
      ? { success: true, resolvers: [], canCreate }
      : { success: true, credentials }),
  })) as unknown as typeof fetch
}

const renderStep = (credentialId: string) =>
  render(React.createElement(StepDrawer, {
    node: { id: 'h1', type: 'http', data: { method: 'GET', url: 'https://api.test/x', credentialId } } as FlowNode,
    flowId: 'f1', agents: [], toolCatalog: [], dataFields: [], labelCtx: {} as never,
    onChange: () => {}, onChangeType: () => {}, onDelete: () => {}, onClose: () => {},
  }))

afterEach(() => cleanup())

test('a member sees Re-verify on their own credential but no Make per-user', async () => {
  stub({ credentials: [credential()], canCreate: false })
  renderStep('mine')
  await flush()
  assert.ok(screen.getByRole('button', { name: /re-verify/i }))
  assert.ok(screen.getByText(/^verified credential —/i))
  assert.equal(screen.queryByRole('button', { name: /make per-user/i }), null)})

test('an integration admin is offered Make per-user', async () => {
  stub({ credentials: [credential()], canCreate: true })
  renderStep('mine')
  await flush()
  assert.ok(screen.getByRole('button', { name: /make per-user/i }))
})

test('no Re-verify on a listed credential the viewer cannot manage', async () => {
  stub({ credentials: [credential({ canManage: false })], canCreate: false })
  renderStep('mine')
  await flush()
  assert.equal(screen.queryByRole('button', { name: /re-verify/i }), null)
})

test('a teammate’s credential is named as theirs, never shown as verified', async () => {
  stub({ credentials: [credential()], canCreate: false })
  renderStep('someone-elses')
  await flush()
  assert.ok(screen.getByText(/belongs to someone else/i))
  assert.equal(screen.queryByText(/^verified credential —/i), null)
  assert.equal(screen.queryByRole('button', { name: /re-verify/i }), null)
})
