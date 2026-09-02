import { test } from 'node:test'
import assert from 'node:assert/strict'
import { embeddedSignInUrl, probeSession, EMBED_SIGNIN_MESSAGE } from '../embed'
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
