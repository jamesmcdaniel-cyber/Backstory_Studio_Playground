import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen } from '@testing-library/react'
import { act } from 'react'
import { JamDialog } from '@/components/flows/jam-dialog'

const flush = async () => {
  await act(async () => { await Promise.resolve() })
}

/** Stub /api/organizations/members with a roster whose caller has `role`. */
function stubMembers(role: 'ADMIN' | 'USER') {
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      success: true,
      selfId: 'me',
      members: [{ id: 'me', name: 'Me', email: 'me@x.test', role }],
    }),
  })) as unknown as typeof fetch
}

const baseProps = {
  open: true as const,
  onOpenChange: () => {},
  flowId: 'f1',
  flowName: 'Flow',
  visibility: 'shared' as const,
  canEdit: true,
  onChangeVisibility: () => {},
}

test('an admin gets an email field for people who are not in the workspace yet', async () => {
  stubMembers('ADMIN')
  render(<JamDialog {...baseProps} />)
  await flush()
  assert.ok(screen.getByPlaceholderText(/teammate@/i), 'admin gets the email field')
  cleanup()
})

test('a non-admin is pointed at the share link instead of a dead end', async () => {
  stubMembers('USER')
  render(<JamDialog {...baseProps} />)
  await flush()
  assert.equal(screen.queryByPlaceholderText(/teammate@/i), null, 'no workspace-invite field for a member')
  assert.ok(screen.getByText(/only an admin can add people to your workspace/i))
  cleanup()
})

test('inviting by email posts the flow as the destination so acceptance lands here', async () => {
  const posts: { url: string; body: Record<string, unknown> }[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url: String(url), body: JSON.parse(String(init.body)) })
      return { ok: true, json: async () => ({ success: true, link: 'https://app.test/invite/tok', emailSent: true }) }
    }
    return {
      ok: true,
      json: async () => ({ success: true, selfId: 'me', members: [{ id: 'me', name: 'Me', email: 'me@x.test', role: 'ADMIN' }] }),
    }
  }) as unknown as typeof fetch

  render(<JamDialog {...baseProps} />)
  await flush()
  const field = screen.getByPlaceholderText(/teammate@/i) as HTMLInputElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(field, 'new@person.test')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    screen.getByRole('button', { name: /^invite$/i }).click()
    await Promise.resolve()
  })

  assert.equal(posts.length, 1)
  assert.match(posts[0].url, /\/api\/organizations\/invitations$/)
  assert.equal(posts[0].body.email, 'new@person.test')
  assert.equal(posts[0].body.next, '/flows/f1', 'acceptance must land on this flow')
  cleanup()
})

test('without a share token the link row says so and offers one-click sharing', async () => {
  stubMembers('ADMIN')
  render(<JamDialog {...baseProps} shareToken={null} />)
  await flush()
  assert.ok(screen.getByText(/only people in your workspace can open this link/i))
  assert.ok(screen.getByRole('button', { name: /make this link work for anyone/i }))
  cleanup()
})

test('with a share token the link row states the role it grants', async () => {
  stubMembers('ADMIN')
  render(<JamDialog {...baseProps} shareToken="tok" shareRole="edit" />)
  await flush()
  assert.ok(screen.getByText(/anyone with this link can sign in and edit/i))
  cleanup()
})
