import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SLACK_BOT_SCOPES,
  buildSlackAuthorizeUrl,
  parseOAuthAccess,
  stateIsFresh,
} from '@/lib/slack/install'

test('the authorize URL carries the client id, redirect, state and scopes', () => {
  const url = new URL(
    buildSlackAuthorizeUrl({
      clientId: 'client-123',
      redirectUri: 'https://app.example/api/slack/oauth/callback',
      state: 'state-abc',
    }),
  )
  assert.equal(url.origin + url.pathname, 'https://slack.com/oauth/v2/authorize')
  assert.equal(url.searchParams.get('client_id'), 'client-123')
  assert.equal(url.searchParams.get('state'), 'state-abc')
  assert.equal(url.searchParams.get('redirect_uri'), 'https://app.example/api/slack/oauth/callback')
  assert.equal(url.searchParams.get('scope'), SLACK_BOT_SCOPES)
})

test('the requested scopes cover mentions, replying as a teammate, and backfill', () => {
  const scopes = SLACK_BOT_SCOPES.split(',')
  // app_mentions:read — without it mentions never arrive at all.
  assert.ok(scopes.includes('app_mentions:read'))
  assert.ok(scopes.includes('chat:write'))
  // chat:write.customize is what lets a reply wear the teammate's own name and
  // avatar. Without it every teammate posts as one undifferentiated bot.
  assert.ok(scopes.includes('chat:write.customize'))
  // Carried over from the BYO scope list: the activity backfill reads history
  // and enumerates channels. Dropping these silently breaks it for installs.
  assert.ok(scopes.includes('channels:history'))
  assert.ok(scopes.includes('channels:read'))
})

test('parseOAuthAccess reads the token, team and bot user from a success body', () => {
  const parsed = parseOAuthAccess({
    ok: true,
    access_token: 'xoxb-real',
    bot_user_id: 'U0BOT',
    team: { id: 'T123', name: 'Acme' },
    scope: SLACK_BOT_SCOPES,
  })
  assert.deepEqual(parsed, { botToken: 'xoxb-real', teamId: 'T123', botUserId: 'U0BOT' })
})

test('stateIsFresh bounds the window server-side and fails closed', () => {
  const now = 1_800_000_000_000
  assert.equal(stateIsFresh(now, now), true)
  assert.equal(stateIsFresh(now - 599_000, now), true)
  assert.equal(stateIsFresh(now - 601_000, now), false)
  // Future-dated and unparseable both fail closed rather than reading as fresh.
  assert.equal(stateIsFresh(now + 5_000, now), false)
  assert.equal(stateIsFresh(Number.NaN, now), false)
  assert.equal(stateIsFresh(undefined as unknown as number, now), false)
})

test('parseOAuthAccess returns null for anything that is not a complete success', () => {
  // Slack answers HTTP 200 even for a rejected exchange, so `ok` is the real
  // result — never the status code.
  assert.equal(parseOAuthAccess({ ok: false, error: 'invalid_code' }), null)
  assert.equal(parseOAuthAccess({ ok: true, bot_user_id: 'U0BOT', team: { id: 'T123' } }), null)
  assert.equal(parseOAuthAccess({ ok: true, access_token: 'xoxb-real', team: { id: 'T123' } }), null)
  assert.equal(parseOAuthAccess({ ok: true, access_token: 'xoxb-real', bot_user_id: 'U0BOT' }), null)
  assert.equal(parseOAuthAccess({ ok: true, access_token: '', bot_user_id: 'U0BOT', team: { id: 'T123' } }), null)
  assert.equal(parseOAuthAccess(null), null)
  assert.equal(parseOAuthAccess('nope'), null)
})
