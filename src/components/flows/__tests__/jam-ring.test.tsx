import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen } from '@testing-library/react'
import { act } from 'react'
import { JamDialog } from '@/components/flows/jam-dialog'

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

const selectAdaAndSend = async () => {
  await act(async () => { screen.getByText('Ada').click() })
  await act(async () => {
    screen.getByRole('button', { name: /^(ring|send invite)/i }).click()
    await Promise.resolve()
  })
}

test('with no huddle live the dialog still sends a plain jam invite', async () => {
  const posts: { url: string; body: Record<string, unknown> }[] = []
  stubRoster(posts)
  render(<JamDialog {...baseProps} />)
  await flush()
  await selectAdaAndSend()
  const invite = posts.find((post) => post.url.includes('/invite'))
  assert.ok(invite, 'posted to the flow invite endpoint')
  assert.equal(invite!.body.kind, 'jam')
  cleanup()
})

test('while in a huddle the same button rings instead of inviting', async () => {
  const posts: { url: string; body: Record<string, unknown> }[] = []
  stubRoster(posts)
  render(<JamDialog {...baseProps} huddleJoined />)
  await flush()
  assert.ok(screen.getByRole('button', { name: /select teammates to ring/i }))
  await selectAdaAndSend()
  const invite = posts.find((post) => post.url.includes('/invite'))
  assert.ok(invite)
  assert.equal(invite!.body.kind, 'huddle')
  cleanup()
})
