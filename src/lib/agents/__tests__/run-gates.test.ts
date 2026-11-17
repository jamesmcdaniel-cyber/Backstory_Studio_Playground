import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentRunRefusal } from '@/lib/agents/run-errors'
import { replyKeyProblem, replyKeyProblemMessage, type ReplyKeyState } from '@/lib/agents/external/types'

/**
 * The two gates a run passes before anything is sent anywhere: may this agent
 * run at all, and (for an external agent) could its answer ever get back.
 */

test('an active, unquarantined agent may run', () => {
  assert.equal(agentRunRefusal({ status: 'ACTIVE', quarantinedAt: null }), null)
  assert.equal(agentRunRefusal({ status: 'ACTIVE' }), null)
})

test('a missing or inactive agent is refused as unavailable', () => {
  assert.equal(agentRunRefusal(null)?.code, 'AGENT_UNAVAILABLE')
  assert.equal(agentRunRefusal({ status: 'PAUSED' })?.code, 'AGENT_UNAVAILABLE')
})

test('a quarantined agent is refused even while ACTIVE — the queued-job and trigger paths relied on status alone', () => {
  const refusal = agentRunRefusal({ status: 'ACTIVE', quarantinedAt: new Date() })
  assert.equal(refusal?.code, 'AGENT_QUARANTINED')
  assert.match(refusal!.message, /claims it/)
})

const now = new Date('2026-11-17T12:00:00Z')
const key = (over: Partial<NonNullable<ReplyKeyState>> = {}): ReplyKeyState => ({
  organizationId: 'org-1',
  revokedAt: null,
  expiresAt: new Date('2027-01-01T00:00:00Z'),
  user: { isActive: true, organizationId: 'org-1' },
  ...over,
})

test('a live reply key owned by an active member is usable', () => {
  assert.equal(replyKeyProblem(key(), now), null)
  assert.equal(replyKeyProblem(key({ expiresAt: null }), now), null)
})

test('the reply key states that authentication refuses are caught before a task is sent', () => {
  assert.equal(replyKeyProblem(null, now), 'missing')
  assert.equal(replyKeyProblem(key({ revokedAt: new Date('2026-11-01') }), now), 'revoked')
  assert.equal(replyKeyProblem(key({ expiresAt: new Date('2026-11-17T11:59:59Z') }), now), 'expired')
  // The registrant deprovisioned (revocation may not have run) or moved away:
  // public-api auth refuses both, so the key is dead either way.
  assert.equal(replyKeyProblem(key({ user: { isActive: false, organizationId: 'org-1' } }), now), 'owner_removed')
  assert.equal(replyKeyProblem(key({ user: { isActive: true, organizationId: 'org-2' } }), now), 'owner_removed')
  assert.equal(replyKeyProblem(key({ user: null }), now), 'owner_removed')
})

test('the failure says what to do, not just what broke', () => {
  assert.match(replyKeyProblemMessage('Researcher', 'revoked'), /^Researcher has had its reply API key revoked.*Issue a new API key/)
})
