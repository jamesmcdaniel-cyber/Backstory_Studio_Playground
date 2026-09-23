import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMBED_COMPLETE_PATH,
  EMBED_CONNECT_DONE_MESSAGE,
  EMBED_SIGNIN_MESSAGE,
  embeddedSignInUrl,
  probeSession,
  resolveEmbedCompletion,
} from '../embed'
import { safeReturnToPath } from '../mcp/oauth-authcode'
import { validatedReturnPath } from '../auth/return-path'

test('the popup lands on a path the return-path validator accepts', () => {
  const url = new URL(embeddedSignInUrl(), 'https://example.com')
  const returnTo = url.searchParams.get('return_to')
  assert.equal(validatedReturnPath(returnTo), '/auth/embedded-complete')
})

test('probeSession: 200 means signed in, a redirect means not yet, a network error means not yet', async () => {
  assert.equal(await probeSession((async () => ({ status: 200 })) as unknown as typeof fetch), true)
  assert.equal(await probeSession((async () => ({ status: 0 })) as unknown as typeof fetch), false) // opaqueredirect
  assert.equal(await probeSession((async () => { throw new Error('offline') }) as unknown as typeof fetch), false)
})

test('the message constant is namespaced so foreign postMessages cannot collide', () => {
  assert.match(EMBED_SIGNIN_MESSAGE, /^backstory:/)
})

test('the popup landing page reads a sign-in landing as a sign-in', () => {
  assert.deepEqual(resolveEmbedCompletion(''), { outcome: 'signed-in', message: EMBED_SIGNIN_MESSAGE })
  assert.deepEqual(resolveEmbedCompletion('?'), { outcome: 'signed-in', message: EMBED_SIGNIN_MESSAGE })
})

test('a connect flow that succeeded is reported as connected, whichever step ran', () => {
  // The MCP callback appends connected=1; the People.ai callback appends
  // peopleai=connected. Both land on the same page in the popup.
  assert.deepEqual(resolveEmbedCompletion('?connected=1'), {
    outcome: 'connected',
    message: EMBED_CONNECT_DONE_MESSAGE,
  })
  assert.deepEqual(resolveEmbedCompletion('?peopleai=connected'), {
    outcome: 'connected',
    message: EMBED_CONNECT_DONE_MESSAGE,
  })
})

test('a connect flow that failed is reported as failed, not as a silent success', () => {
  for (const search of ['?error=oauth', '?error=oauth_state', '?peopleai=error', '?peopleai=team-mismatch', '?peopleai=state-mismatch']) {
    assert.deepEqual(
      resolveEmbedCompletion(search),
      { outcome: 'failed', message: EMBED_CONNECT_DONE_MESSAGE },
      search,
    )
  }
})

test('the connect-done message is namespaced and distinct from the sign-in one', () => {
  assert.match(EMBED_CONNECT_DONE_MESSAGE, /^backstory:/)
  assert.notEqual(EMBED_CONNECT_DONE_MESSAGE, EMBED_SIGNIN_MESSAGE)
})

test('the popup landing path is one the return-path validators accept', () => {
  assert.equal(validatedReturnPath(EMBED_COMPLETE_PATH), EMBED_COMPLETE_PATH)
  assert.equal(safeReturnToPath(EMBED_COMPLETE_PATH), EMBED_COMPLETE_PATH)
})
