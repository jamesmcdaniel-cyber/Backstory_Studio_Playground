import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { render, cleanup } from '@testing-library/react'
import { useFlowSharing, type FlowSharing } from '@/components/flows/use-flow-sharing'

/**
 * The flow editor page's first tests.
 *
 * `src/app/flows/[id]/page.tsx` is the largest component in the app and had no
 * tests at all. The harness has existed for a while (34 `.test.tsx` files, 20
 * of them under components/flows), so what was missing was not tooling but
 * state that anything could reach: it lived inline in the component.
 *
 * They live HERE, and not in `src/app/flows/[id]/__tests__/`, for a reason
 * worth knowing: Node's test runner treats its positional arguments as GLOBS,
 * and `[id]` is a character class. A test file under a Next.js dynamic-route
 * directory is therefore never matched — the run reports `# tests 0` and exits
 * 0, so it looks like it passed. `find` lists the file, `npm test` silently
 * ignores it. A guard in src/lib/__tests__/test-discovery.test.ts fails if one
 * is ever added under a bracketed path again.
 *
 * These cover the state that has been carved out of it so far:
 *  - undo/redo — src/lib/flows/__tests__/graph-history.test.ts (the rules) and
 *    src/components/flows/__tests__/use-graph-history.test.tsx (the burst timer)
 *  - share links — here
 */

function mountSharing() {
  const ref: { current: FlowSharing | null } = { current: null }
  function Probe() {
    ref.current = useFlowSharing()
    return null
  }
  render(<Probe />)
  return ref as { current: FlowSharing }
}

test('a link starts absent, and hydrating a flow reports what the server knows', async (t) => {
  t.after(cleanup)
  const sharing = mountSharing()
  assert.equal(sharing.current.enabled, false)
  assert.equal(sharing.current.token, null)

  await act(async () => {
    sharing.current.hydrate({ shareEnabled: true, shareRole: 'edit', shareAnonymous: true, anonymousViews: 7 })
  })
  assert.equal(sharing.current.enabled, true)
  assert.equal(sharing.current.role, 'edit')
  assert.equal(sharing.current.anonymous, true)
  assert.equal(sharing.current.views, 7)
})

test('hydrating never invents a token, because the server only has a digest', async (t) => {
  t.after(cleanup)
  const sharing = mountSharing()
  await act(async () => {
    sharing.current.applyChange('tok_live', true, 'view', false, 0)
  })
  assert.equal(sharing.current.token, 'tok_live')

  // A reload re-hydrates from the flow row, which carries no plaintext.
  await act(async () => {
    sharing.current.hydrate({ shareEnabled: true, shareRole: 'view', shareAnonymous: false, anonymousViews: 3 })
  })
  assert.equal(sharing.current.enabled, true, 'the link is still live')
  assert.equal(sharing.current.token, 'tok_live', 'hydrate must not touch the minted plaintext')
})

test('changing the role does NOT wipe the token already on screen', async (t) => {
  t.after(cleanup)
  const sharing = mountSharing()
  await act(async () => { sharing.current.applyChange('tok_minted', true, 'view', false, 0) })

  // A role change returns no plaintext. Clearing it here would be unrecoverable:
  // the server stores only a digest, so the user would have to rotate the link
  // and re-send it to everyone who has it.
  await act(async () => { sharing.current.applyChange(null, true, 'edit', false, 0) })
  assert.equal(sharing.current.token, 'tok_minted')
  assert.equal(sharing.current.role, 'edit')
})

test('disabling the link DOES clear the token', async (t) => {
  t.after(cleanup)
  const sharing = mountSharing()
  await act(async () => { sharing.current.applyChange('tok_minted', true, 'view', false, 0) })
  await act(async () => { sharing.current.applyChange(null, false, 'view', false, 0) })
  assert.equal(sharing.current.enabled, false)
  assert.equal(sharing.current.token, null, 'a revoked link must not stay copyable')
})

test('a rotate replaces the token rather than keeping the old one', async (t) => {
  t.after(cleanup)
  const sharing = mountSharing()
  await act(async () => { sharing.current.applyChange('tok_old', true, 'view', false, 0) })
  await act(async () => { sharing.current.applyChange('tok_new', true, 'view', false, 0) })
  assert.equal(sharing.current.token, 'tok_new')
})

test('anonymous view counts follow the server, including back down to zero', async (t) => {
  t.after(cleanup)
  const sharing = mountSharing()
  await act(async () => { sharing.current.applyChange(null, true, 'view', true, 12) })
  assert.equal(sharing.current.views, 12)
  // Rotating a link resets its view count; the UI must follow rather than
  // keep the previous link's total.
  await act(async () => { sharing.current.applyChange('tok_rotated', true, 'view', true, 0) })
  assert.equal(sharing.current.views, 0)
})
