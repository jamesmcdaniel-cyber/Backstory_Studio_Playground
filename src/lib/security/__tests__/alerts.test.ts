import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alertSecurityThreshold, setSecurityAlertSender, securityAlertRecipients, type SecurityAlert } from '../alerts'

function alert(overrides: Partial<SecurityAlert> = {}): SecurityAlert {
  return {
    kind: 'auth.failed',
    subject: 'test-subject',
    threshold: 20,
    windowMs: 300_000,
    path: '/api/flows',
    ip: '203.0.113.7',
    userId: null,
    organizationId: null,
    ...overrides,
  }
}

test('sends an alert the first time a threshold is crossed', async () => {
  const sent: SecurityAlert[] = []
  setSecurityAlertSender(async (a) => { sent.push(a) })
  try {
    await alertSecurityThreshold(alert({ subject: 'first-cross' }))
    assert.equal(sent.length, 1)
    assert.equal(sent[0].subject, 'first-cross')
  } finally {
    setSecurityAlertSender(null)
  }
})

test('suppresses repeats for the same subject inside the cooldown', async () => {
  // The point of the cooldown: an attack sustained for an hour is one email,
  // not one per request. Without this the alert channel becomes the flood.
  const sent: SecurityAlert[] = []
  setSecurityAlertSender(async (a) => { sent.push(a) })
  try {
    for (let i = 0; i < 5; i++) await alertSecurityThreshold(alert({ subject: 'repeat-subject' }))
    assert.equal(sent.length, 1, 'only the first crossing should send')
  } finally {
    setSecurityAlertSender(null)
  }
})

test('different subjects alert independently', async () => {
  const sent: SecurityAlert[] = []
  setSecurityAlertSender(async (a) => { sent.push(a) })
  try {
    await alertSecurityThreshold(alert({ subject: 'subject-a' }))
    await alertSecurityThreshold(alert({ subject: 'subject-b' }))
    assert.deepEqual(sent.map((a) => a.subject), ['subject-a', 'subject-b'])
  } finally {
    setSecurityAlertSender(null)
  }
})

test('the same subject under a different event kind is a separate alert', async () => {
  const sent: SecurityAlert[] = []
  setSecurityAlertSender(async (a) => { sent.push(a) })
  try {
    await alertSecurityThreshold(alert({ subject: 'multi-kind', kind: 'auth.failed' }))
    await alertSecurityThreshold(alert({ subject: 'multi-kind', kind: 'auth.token_invalid' }))
    assert.equal(sent.length, 2, 'cooldown is per (kind, subject), not per subject')
  } finally {
    setSecurityAlertSender(null)
  }
})

test('a failing sender never throws into the caller', async () => {
  // Alerting runs inside a request that has already been refused. If it threw,
  // a 401 would become a 500 — a bug an attacker could trigger deliberately.
  setSecurityAlertSender(async () => { throw new Error('smtp exploded') })
  try {
    await assert.doesNotReject(() => alertSecurityThreshold(alert({ subject: 'failing-sender' })))
  } finally {
    setSecurityAlertSender(null)
  }
})

test('no configured recipients is a quiet no-op, not an error', async () => {
  const previous = process.env.SECURITY_ALERT_EMAIL
  delete process.env.SECURITY_ALERT_EMAIL
  try {
    assert.deepEqual(securityAlertRecipients(), [])
    await assert.doesNotReject(() => alertSecurityThreshold(alert({ subject: 'no-recipients' })))
  } finally {
    if (previous === undefined) delete process.env.SECURITY_ALERT_EMAIL
    else process.env.SECURITY_ALERT_EMAIL = previous
  }
})

test('recipients parse from a comma-separated list, trimming blanks', () => {
  const previous = process.env.SECURITY_ALERT_EMAIL
  process.env.SECURITY_ALERT_EMAIL = ' security@example.com , ops@example.com ,, '
  try {
    assert.deepEqual(securityAlertRecipients(), ['security@example.com', 'ops@example.com'])
  } finally {
    if (previous === undefined) delete process.env.SECURITY_ALERT_EMAIL
    else process.env.SECURITY_ALERT_EMAIL = previous
  }
})
