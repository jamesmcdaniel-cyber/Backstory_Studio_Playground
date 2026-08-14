import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientIp, recordSecurityEvent, recordTokenRejection, requestPath, securityThreshold } from '../events'
import { setSecurityAlertSender, type SecurityAlert } from '../alerts'

test('clientIp takes the first forwarded hop', () => {
  const headers = new Headers({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18, 150.172.238.178' })
  assert.equal(clientIp({ headers }), '203.0.113.7')
})

test('clientIp falls back to "unknown" rather than throwing on a missing header', () => {
  assert.equal(clientIp({ headers: new Headers() }), 'unknown')
})

test('requestPath drops the query string', () => {
  // Token surfaces accept credentials in the query on some integrations; the
  // recorded path must never become the place a rejected secret gets logged.
  assert.equal(requestPath({ url: 'https://app.example.com/api/v1/flows?token=supersecret' }), '/api/v1/flows')
})

test('requestPath returns "unknown" for an unparseable url instead of throwing', () => {
  assert.equal(requestPath({ url: 'not a url' }), 'unknown')
})

test('every event kind has a threshold', () => {
  for (const kind of ['auth.failed', 'auth.forbidden', 'auth.token_invalid', 'abuse.rate_limited', 'abuse.body_too_large'] as const) {
    const threshold = securityThreshold(kind)
    assert.ok(threshold.limit > 0, `${kind} needs a positive limit`)
    assert.ok(threshold.windowMs > 0, `${kind} needs a positive window`)
  }
})

test('permission denials alert sooner than rate limiting', () => {
  // A legitimate user does not walk into twenty permission denials in five
  // minutes, but a runaway client loop trips the rate limiter harmlessly and
  // repeatedly. If these two ever invert, the noisy signal starts paging.
  assert.ok(securityThreshold('auth.forbidden').limit < securityThreshold('abuse.rate_limited').limit)
})

test('an anonymous event records without an organization and does not throw', async () => {
  await assert.doesNotReject(() =>
    recordSecurityEvent({
      kind: 'auth.failed',
      path: '/api/flows',
      method: 'POST',
      ip: '203.0.113.7',
      subject: 'anon-no-org',
    }),
  )
})

test('alerts once the subject crosses the threshold for its kind', async () => {
  const sent: SecurityAlert[] = []
  setSecurityAlertSender(async (alert) => { sent.push(alert) })
  try {
    const { limit } = securityThreshold('auth.token_invalid')
    const subject = 'threshold-crossing-subject'
    for (let i = 0; i < limit; i++) {
      await recordSecurityEvent({ kind: 'auth.token_invalid', path: '/api/v1/flows', method: 'POST', subject })
      assert.equal(sent.length, 0, `should stay quiet at ${i + 1} of ${limit}`)
    }
    await recordSecurityEvent({ kind: 'auth.token_invalid', path: '/api/v1/flows', method: 'POST', subject })
    assert.equal(sent.length, 1, 'the call past the limit should alert')
    assert.equal(sent[0].kind, 'auth.token_invalid')
    assert.equal(sent[0].subject, subject)
  } finally {
    setSecurityAlertSender(null)
  }
})

test('a subject below its threshold never alerts', async () => {
  const sent: SecurityAlert[] = []
  setSecurityAlertSender(async (alert) => { sent.push(alert) })
  try {
    const { limit } = securityThreshold('auth.failed')
    for (let i = 0; i < limit - 1; i++) {
      await recordSecurityEvent({ kind: 'auth.failed', path: '/api/flows', method: 'POST', subject: 'quiet-subject' })
    }
    assert.equal(sent.length, 0)
  } finally {
    setSecurityAlertSender(null)
  }
})

test('token rejections are counted per surface and IP, not per token', async () => {
  // The rejected credential must never become a counter key — it would put the
  // secret into the limiter backend. Surface + IP is what identifies the flood.
  const sent: SecurityAlert[] = []
  setSecurityAlertSender(async (alert) => { sent.push(alert) })
  try {
    const { limit } = securityThreshold('auth.token_invalid')
    const request = new Request('https://app.example.com/api/agents/abc/trigger?secret=leakme', {
      method: 'POST',
      headers: { 'x-forwarded-for': '198.51.100.4' },
    })
    for (let i = 0; i <= limit; i++) {
      await recordTokenRejection(request, { surface: 'agent-trigger', reason: 'invalid_secret' })
    }
    assert.equal(sent.length, 1)
    assert.equal(sent[0].subject, 'agent-trigger:198.51.100.4')
    assert.ok(!sent[0].subject.includes('leakme'), 'the rejected credential must not reach the counter key')
    assert.equal(sent[0].path, '/api/agents/abc/trigger', 'query string must be stripped')
  } finally {
    setSecurityAlertSender(null)
  }
})

test('recording survives an alert sender that throws', async () => {
  setSecurityAlertSender(async () => { throw new Error('pager down') })
  try {
    const { limit } = securityThreshold('abuse.body_too_large')
    for (let i = 0; i <= limit; i++) {
      await assert.doesNotReject(() =>
        recordSecurityEvent({ kind: 'abuse.body_too_large', path: '/api/files', method: 'POST', subject: 'throwing-alert' }),
      )
    }
  } finally {
    setSecurityAlertSender(null)
  }
})
