import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canDecideReview, canEnableReviewPolicy, canPublish, type ReviewState } from '@/lib/flows/review-gate'

/**
 * A published flow runs on a schedule against real customer systems with nobody
 * watching. The whole value of this gate is the cases where it says NO, so those
 * are what is pinned here.
 */

const OFF = { required: false }
const ON = { required: true }
const approved = (over: Partial<ReviewState> = {}): ReviewState => ({
  status: 'approved',
  requestedBy: 'author',
  decidedBy: 'reviewer',
  graphFingerprint: 'sha-1',
  ...over,
})

test('with the policy off, publishing is unchanged', () => {
  assert.deepEqual(canPublish({ policy: OFF, actorUserId: 'author', review: null, currentFingerprint: 'sha-1' }), {
    allowed: true,
  })
})

test('with the policy on, publishing without a review is refused', () => {
  const decision = canPublish({ policy: ON, actorUserId: 'author', review: null, currentFingerprint: 'sha-1' })
  assert.equal(decision.allowed, false)
  assert.equal(decision.allowed === false && decision.reason, 'review_required')
})

test('a pending review is not permission to publish', () => {
  const decision = canPublish({
    policy: ON,
    actorUserId: 'author',
    review: { status: 'open', requestedBy: 'author' },
    currentFingerprint: 'sha-1',
  })
  assert.equal(decision.allowed === false && decision.reason, 'review_pending')
})

test('a rejected review says what to do next', () => {
  const decision = canPublish({
    policy: ON,
    actorUserId: 'author',
    review: { status: 'rejected', requestedBy: 'author' },
    currentFingerprint: 'sha-1',
  })
  assert.equal(decision.allowed === false && decision.reason, 'review_rejected')
  assert.match(decision.allowed === false ? decision.message : '', /ask for another review/i)
})

test('an approval covers the draft that was read, not the flow forever', () => {
  // Edit-after-approval is the failure a review process exists to prevent:
  // publishing would ship something nobody looked at.
  const decision = canPublish({
    policy: ON,
    actorUserId: 'author',
    review: approved({ graphFingerprint: 'sha-1' }),
    currentFingerprint: 'sha-2-edited-after',
  })
  assert.equal(decision.allowed === false && decision.reason, 'review_stale')
})

test('an approval of the current draft allows the publish', () => {
  assert.deepEqual(
    canPublish({ policy: ON, actorUserId: 'author', review: approved(), currentFingerprint: 'sha-1' }),
    { allowed: true },
  )
})

test('a withdrawn review is as good as none', () => {
  const decision = canPublish({
    policy: ON,
    actorUserId: 'author',
    review: { status: 'withdrawn', requestedBy: 'author' },
    currentFingerprint: 'sha-1',
  })
  assert.equal(decision.allowed === false && decision.reason, 'review_required')
})

test('nobody approves their own change — not even an owner', () => {
  // An owner can do anything else in the workspace. The point of the gate is a
  // second pair of eyes, so this holds for them too.
  const self = canDecideReview({ requestedBy: 'author', status: 'open' }, 'author')
  assert.equal(self.allowed, false)
  assert.match(self.message ?? '', /someone other than/i)

  assert.equal(canDecideReview({ requestedBy: 'author', status: 'open' }, 'reviewer').allowed, true)
})

test('a decided review cannot be decided again', () => {
  assert.equal(canDecideReview({ requestedBy: 'author', status: 'approved' }, 'reviewer').allowed, false)
  assert.equal(canDecideReview({ requestedBy: 'author', status: 'rejected' }, 'reviewer').allowed, false)
})

test('a workspace of one cannot turn the gate on', () => {
  // It would lock itself out of publishing: nobody else exists to approve.
  // Refused where the policy is set, not discovered where someone tries to ship.
  const alone = canEnableReviewPolicy(1)
  assert.equal(alone.allowed, false)
  assert.match(alone.message ?? '', /invite a colleague/i)
  assert.equal(canEnableReviewPolicy(2).allowed, true)
})
