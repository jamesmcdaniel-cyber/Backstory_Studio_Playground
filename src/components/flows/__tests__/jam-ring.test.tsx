import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen } from '@testing-library/react'
import { act } from 'react'
import { JamDialog } from '@/components/flows/jam-dialog'
import type { FlowHuddle } from '@/lib/flows/use-flow-huddle'

/** A huddle we are in. Only the fields the dialog reads need to be real. */
const joinedHuddle = {
  joined: true,
  connecting: false,
  muted: false,
  pttEnabled: false,
  transmitting: true,
  error: null,
  speakingIds: new Set<string>(),
  peerStates: new Map(),
  peerAudio: new Map(),
  join: async () => {},
  leave: () => {},
  toggleMute: () => {},
  setPttEnabled: () => {},
  setPeerAudio: () => {},
  clearError: () => {},
} as unknown as FlowHuddle

const flush = async () => { await act(async () => { await Promise.resolve() }) }

const baseProps = {
  open: true as const,
  onOpenChange: () => {},
  flowId: 'f1',
  flowName: 'Flow',
  visibility: 'shared' as const,
  canEdit: true,
  onChangeVisibility: () => {},
}

/** Roster with one other member, capturing POSTs to the flow-invite endpoint. */
function stubRoster(posts: { url: string; body: Record<string, unknown> }[]) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url: String(url), body: JSON.parse(String(init.body)) })
      return { ok: true, json: async () => ({ success: true, invited: 1 }) }
    }
    return {
      ok: true,
      json: async () => ({
        success: true,
        selfId: 'me',
        members: [
          { id: 'me', name: 'Me', email: 'me@x.test', role: 'ADMIN' },
          { id: 'u2', name: 'Ada', email: 'ada@x.test', role: 'USER' },
        ],
      }),
    }
  }) as unknown as typeof fetch
}

/** Ada's row in the one people list (presence chips carry her name too). */
const adaRow = () => {
  const row = screen.getAllByText('Ada').map((node) => node.closest('li')).find(Boolean)
  assert.ok(row, 'Ada has a row in the people list')
  return row!
}

/** One click on Ada's own row is the whole interaction — no select-then-send. */
const pingAda = async (label: RegExp) => {
  const row = adaRow()
  const button = Array.from(row.querySelectorAll('button')).find((b) => label.test((b.textContent ?? '').trim()))
  assert.ok(button, `Ada's row has a ${label} button`)
  await act(async () => {
    button!.click()
    await Promise.resolve()
  })
}

test('with no huddle live the dialog still sends a plain jam invite', async () => {
  const posts: { url: string; body: Record<string, unknown> }[] = []
  stubRoster(posts)
  render(<JamDialog {...baseProps} />)
  await flush()
  await pingAda(/^ping$/i)
  const invite = posts.find((post) => post.url.includes('/invite'))
  assert.ok(invite, 'posted to the flow invite endpoint')
  assert.equal(invite!.body.kind, 'jam')
  cleanup()
})

test('while in a huddle the same button rings instead of inviting', async () => {
  const posts: { url: string; body: Record<string, unknown> }[] = []
  stubRoster(posts)
  render(<JamDialog {...baseProps} huddle={joinedHuddle} />)
  await flush()
  await pingAda(/^ring$/i)
  const invite = posts.find((post) => post.url.includes('/invite'))
  assert.ok(invite)
  assert.equal(invite!.body.kind, 'huddle')
  cleanup()
})

test('a teammate already in the jam is shown as here, not offered a ping', async () => {
  const posts: { url: string; body: Record<string, unknown> }[] = []
  stubRoster(posts)
  render(
    <JamDialog
      {...baseProps}
      presence={[{ id: 'c2', userId: 'u2', name: 'Ada', color: '#111' }]}
    />,
  )
  await flush()
  const row = adaRow()
  assert.ok(/in the jam/i.test(row.textContent ?? ''), 'the row says they are already here')
  assert.equal(
    Array.from(row.querySelectorAll('button')).find((b) => /ping/i.test(b.textContent ?? '')),
    undefined,
    'no ping button for someone already in the jam',
  )
  cleanup()
})
