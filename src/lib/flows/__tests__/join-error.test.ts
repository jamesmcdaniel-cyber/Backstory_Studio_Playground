import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joinErrorMessage } from '../join-error'

test('an invalid share link is named as such, with the account you are signed in as', () => {
  const message = joinErrorMessage('SHARE_LINK_INVALID', 'sam@work.test')
  assert.match(message.title, /link/i)
  assert.match(message.body, /sam@work\.test/)
  assert.equal(message.canSwitchAccount, true)
})

test('a no-access failure never claims the flow exists', () => {
  const message = joinErrorMessage('NOT_FOUND', 'sam@work.test')
  assert.match(message.title, /couldn’t open/i)
  assert.doesNotMatch(message.body, /share link/i)
  assert.equal(message.canSwitchAccount, true)
})

test('a transient failure reads as transient and offers no account switch', () => {
  const message = joinErrorMessage(null, null)
  assert.match(message.body, /try again/i)
  assert.equal(message.canSwitchAccount, false)
})

test('a signed-out viewer is never told to switch accounts', () => {
  assert.equal(joinErrorMessage('SHARE_LINK_INVALID', null).canSwitchAccount, false)
  assert.equal(joinErrorMessage('NOT_FOUND', null).canSwitchAccount, false)
})
