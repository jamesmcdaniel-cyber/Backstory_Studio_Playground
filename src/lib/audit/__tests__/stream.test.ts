import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STREAM_SIGNATURE_TOLERANCE_SECONDS,
  destinationWants,
  signStreamDelivery,
  streamPayload,
  verifyStreamDelivery,
} from '@/lib/audit/stream'

const dest = (over: Partial<{ actionPrefixes: string[]; isActive: boolean }> = {}) => ({
  id: 'd1',
  actionPrefixes: [] as string[],
  isActive: true,
  ...over,
})

test('a destination with no filter takes everything', () => {
  // What someone setting up a SIEM feed almost always wants.
  assert.equal(destinationWants(dest(), 'flow.published'), true)
  assert.equal(destinationWants(dest(), 'credential.rotated'), true)
})

test('a prefix selects its namespace and nothing adjacent', () => {
  const only = dest({ actionPrefixes: ['credential'] })
  assert.equal(destinationWants(only, 'credential.rotated'), true)
  assert.equal(destinationWants(only, 'credential'), true)
  assert.equal(destinationWants(only, 'flow.published'), false)
  // A later namespace must not silently join a feed nobody asked to widen.
  assert.equal(destinationWants(only, 'credentialsomething.leaked'), false)
})

test('a trailing dot in a prefix is tolerated', () => {
  assert.equal(destinationWants(dest({ actionPrefixes: ['flow.'] }), 'flow.published'), true)
})

test('an inactive destination receives nothing', () => {
  assert.equal(destinationWants(dest({ isActive: false }), 'flow.published'), false)
})

test('the delivered body is a fixed, reviewed shape — never the raw row', () => {
  // `detail` is a JSON grab-bag written by dozens of call sites; forwarding it
  // verbatim to a third party is how something nobody audited leaves the building.
  const body = streamPayload({
    id: 'e1',
    action: 'flow.published',
    organizationId: 'org1',
    actorUserId: 'u1',
    actorKind: 'user',
    resourceType: 'flow',
    resourceId: 'f1',
    ip: '203.0.113.9',
    createdAt: new Date('2026-08-25T10:00:00Z'),
    detail: { secretish: 'do not forward me' },
  })

  assert.equal(body.action, 'flow.published')
  assert.equal(body.occurredAt, '2026-08-25T10:00:00.000Z')
  assert.deepEqual(body.resource, { type: 'flow', id: 'f1' })
  assert.equal('detail' in body, false)
  assert.doesNotMatch(JSON.stringify(body), /do not forward me/)
})

test('a delivery verifies against its own signature', () => {
  const body = JSON.stringify({ id: 'e1' })
  const at = 1_780_000_000
  const signature = signStreamDelivery('shh', body, at)
  assert.equal(verifyStreamDelivery({ secret: 'shh', body, timestampSeconds: at, signature, nowSeconds: at + 5 }), true)
})

test('a captured delivery cannot be replayed later', () => {
  // The timestamp is signed WITH the body precisely so this fails; a log feed
  // is exactly where a replayed event would be believed.
  const body = JSON.stringify({ id: 'e1' })
  const at = 1_780_000_000
  const signature = signStreamDelivery('shh', body, at)
  assert.equal(
    verifyStreamDelivery({
      secret: 'shh',
      body,
      timestampSeconds: at,
      signature,
      nowSeconds: at + STREAM_SIGNATURE_TOLERANCE_SECONDS + 1,
    }),
    false,
  )
})

test('a tampered body or a wrong secret fails', () => {
  const at = 1_780_000_000
  const signature = signStreamDelivery('shh', '{"id":"e1"}', at)
  assert.equal(
    verifyStreamDelivery({ secret: 'shh', body: '{"id":"e2"}', timestampSeconds: at, signature, nowSeconds: at }),
    false,
  )
  assert.equal(
    verifyStreamDelivery({ secret: 'other', body: '{"id":"e1"}', timestampSeconds: at, signature, nowSeconds: at }),
    false,
  )
})

test('a signature of the wrong length is rejected, not thrown on', () => {
  // timingSafeEqual throws on a length mismatch rather than returning false.
  const at = 1_780_000_000
  assert.equal(
    verifyStreamDelivery({ secret: 'shh', body: '{}', timestampSeconds: at, signature: 'short', nowSeconds: at }),
    false,
  )
})
