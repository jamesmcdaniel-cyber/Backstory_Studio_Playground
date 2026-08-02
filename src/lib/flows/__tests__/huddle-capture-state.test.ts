import { test } from 'node:test'
import assert from 'node:assert/strict'
import { liveCaptureSession, shouldSummarize } from '../huddle-capture-state'

type P = { clientId: string; inHuddle?: boolean; capturing?: boolean; captureSessionId?: string | null }
const p = (clientId: string, patch: Partial<P> = {}): P => ({ clientId, ...patch })

test('the live session is what the owner advertises', () => {
  const roster = [p('owner', { inHuddle: true, capturing: true, captureSessionId: 's1' }), p('b', { inHuddle: true })]
  assert.equal(liveCaptureSession(roster), 's1')
})

test('followers capturing without a session id never sustain a session', () => {
  // This is the off-switch guarantee: when the owner stops advertising, the
  // room's session dies even though followers are still flagged capturing.
  const roster = [p('a', { inHuddle: true, capturing: true, captureSessionId: null }), p('b', { capturing: true })]
  assert.equal(liveCaptureSession(roster), null)
})

test('an owner who opted their own voice out still keeps the session running', () => {
  const roster = [p('owner', { inHuddle: true, capturing: false, captureSessionId: 's1' })]
  assert.equal(liveCaptureSession(roster), 's1')
})

test('a session is summarized by the LAST huddle participant to leave', () => {
  // Still someone in the huddle → not yet.
  assert.equal(shouldSummarize('s1', [p('a', { inHuddle: true })]), false)
  // Huddle empty, session existed → yes.
  assert.equal(shouldSummarize('s1', [p('a'), p('b')]), true)
  assert.equal(shouldSummarize('s1', []), true)
})

test('no session, nothing to summarize', () => {
  assert.equal(shouldSummarize(null, []), false)
})
