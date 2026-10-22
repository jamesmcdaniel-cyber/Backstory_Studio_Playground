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

test('without a live share link the audience is workspace-only and one chip opens it up', async () => {
  stubMembers('ADMIN')
  render(<JamDialog {...baseProps} shareToken={null} shareEnabled={false} />)
  await flush()
  assert.ok(screen.getByText(/only people in your workspace can open this link/i))
  const workspaceChip = screen.getByRole('button', { name: /^workspace only$/i })
  assert.equal(workspaceChip.getAttribute('aria-pressed'), 'true')
  assert.ok(screen.getByRole('button', { name: /^anyone can edit$/i }), 'one click widens the link')
  cleanup()
})

test('with a live share link the row states the role it grants', async () => {
  stubMembers('ADMIN')
  render(<JamDialog {...baseProps} shareToken="tok" shareEnabled shareRole="edit" />)
  await flush()
  assert.ok(screen.getByText(/anyone with this link can sign in and edit/i))
  cleanup()
})

// The server stores only a digest, so after a reload the link is live but its
// plaintext is gone. The dialog must still report the right audience and say
// why it cannot show the URL — silently falling back to "workspace only" would
// tell the owner their flow is private when it is not.
test('a live link whose plaintext this session lacks still reads as shared', async () => {
  stubMembers('ADMIN')
  render(<JamDialog {...baseProps} shareToken={null} shareEnabled shareRole="view" />)
  await flush()
  assert.equal(
    screen.getByRole('button', { name: /^anyone can view$/i }).getAttribute('aria-pressed'),
    'true',
  )
  assert.ok(screen.getByText(/only shown once when it.s created/i))
  cleanup()
})

test('a teammate on the other view is shown with a follow action, not hidden', async () => {
  stubMembers('ADMIN')
  let followed: string | null = null
  render(
    <JamDialog
      {...baseProps}
      presence={[{ id: 'c2', name: 'Sam', color: '#111', view: 'canvas', label: 'Canvas view', needsFollow: true }]}
      onFollow={(view) => { followed = view }}
    />,
  )
  await flush()
  const follow = screen.getByRole('button', { name: /canvas view — follow/i })
  await act(async () => { follow.click() })
  assert.equal(followed, 'canvas')
  cleanup()
})

test('a teammate on my view gets no follow chip', async () => {
  stubMembers('ADMIN')
  render(
    <JamDialog
      {...baseProps}
      presence={[{ id: 'c2', name: 'Sam', color: '#111', view: 'inline', label: '', needsFollow: false }]}
    />,
  )
  await flush()
  assert.equal(screen.queryByRole('button', { name: /follow/i }), null)
  cleanup()
})

// The panel must never put two URLs on screen: the audience chosen decides the
// single link, and the no-sign-in audience swaps in the public address rather
// than adding a second box beside the builder one. The public link has its OWN
// token (loaded from /public-link), never the jam token.
const PUBLIC_STATE = { success: true, enabled: true, url: 'https://app.test/share/flow/pubtok', views: 2, expiresAt: null, expired: false, allowCopy: false }

function stubWithPublicLink(posts: { url: string; body: Record<string, unknown> }[] = []) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url: String(url), body: JSON.parse(String(init.body)) })
      if (String(url).includes('/public-link')) return { ok: true, json: async () => PUBLIC_STATE }
      return { ok: true, json: async () => ({ success: true, shareEnabled: false, shareRole: 'view', shareAnonymous: true, anonymousViews: 0 }) }
    }
    if (String(url).includes('/public-link')) return { ok: true, json: async () => PUBLIC_STATE }
    return { ok: true, json: async () => ({ success: true, selfId: 'me', members: [] }) }
  }) as unknown as typeof fetch
}

test('one link at a time — the no-sign-in audience swaps the URL, it does not add one', async () => {
  stubWithPublicLink()
  // The dialog portals to the body, so read the whole document.
  render(<JamDialog {...baseProps} shareToken="tok" shareEnabled shareRole="view" shareAnonymous />)
  await flush()
  await flush()
  const shown = document.body.textContent ?? ''
  assert.ok(shown.includes('/share/flow/pubtok'), 'shows the public link')
  assert.ok(!shown.includes('/share/flow/tok'), 'the jam token is never a public URL')
  assert.ok(!shown.includes('?share=tok'), 'and not the builder link as well')
  assert.equal(
    screen.getByRole('button', { name: /^anyone, no sign-in$/i }).getAttribute('aria-pressed'),
    'true',
  )
  assert.ok(screen.getByLabelText(/let signed-in visitors copy it/i), 'the copy opt-in sits with the public link')
  cleanup()
})

test('the sign-in audiences show the builder link, never the public one', async () => {
  stubMembers('ADMIN')
  render(<JamDialog {...baseProps} shareToken="tok" shareEnabled shareRole="edit" />)
  await flush()
  const shown = document.body.textContent ?? ''
  assert.ok(shown.includes('?share=tok'))
  assert.ok(!shown.includes('/share/flow/'))
  cleanup()
})

test('choosing the no-sign-in audience turns the public link on and the jam link off', async () => {
  const posts: { url: string; body: Record<string, unknown> }[] = []
  stubWithPublicLink(posts)
  const changes: unknown[][] = []
  render(<JamDialog {...baseProps} shareToken="tok" shareEnabled shareRole="edit" onShareChanged={(...args) => changes.push(args)} />)
  await flush()
  await act(async () => {
    screen.getByRole('button', { name: /^anyone, no sign-in$/i }).click()
    await Promise.resolve()
  })
  await flush()
  const publicPost = posts.find((post) => post.url.includes('/public-link'))
  assert.ok(publicPost, 'posted to the public-link endpoint')
  assert.equal(publicPost!.body.action, 'enable')
  const jamPost = posts.find((post) => post.url.endsWith('/share'))
  assert.ok(jamPost, 'and turned the jam link off, so one audience is live')
  assert.equal(jamPost!.body.enabled, false)
  assert.equal('anonymous' in jamPost!.body, false, 'the jam link is never asked to be public')
  assert.ok(changes.some((args) => args[3] === true), 'the parent learns the public link is on')
  cleanup()
})
