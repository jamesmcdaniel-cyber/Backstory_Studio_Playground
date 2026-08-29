import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCommand, parseCommandPayload, teamIdFromCommandBody } from '@/lib/slack/command'

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString()

const COMPLETE = {
  team_id: 'T123',
  command: '/dealcheck',
  text: 'Acme Q3 renewal',
  user_id: 'U999',
  channel_id: 'C123',
  channel_name: 'revenue',
  response_url: 'https://hooks.slack.com/commands/T123/456/abc',
  trigger_id: '13345224609.738474920.8088930838d88f008e0',
}

test('a command binds by its normalized word, however the workspace spelled it', () => {
  // Slack echoes the command exactly as the app registered it, so all three of
  // these are the same command typed differently.
  assert.equal(normalizeCommand('/dealcheck'), 'dealcheck')
  assert.equal(normalizeCommand('/DealCheck'), 'dealcheck')
  assert.equal(normalizeCommand('  dealcheck '), 'dealcheck')
  assert.equal(normalizeCommand('//dealcheck'), 'dealcheck')
})

test('a complete command body parses into the fields the dispatcher needs', () => {
  const payload = parseCommandPayload(form(COMPLETE))
  assert.ok(payload)
  assert.equal(payload!.command, 'dealcheck')
  assert.equal(payload!.teamId, 'T123')
  assert.equal(payload!.text, 'Acme Q3 renewal')
  assert.equal(payload!.slackUserId, 'U999')
  assert.equal(payload!.channelId, 'C123')
  assert.equal(payload!.responseUrl, 'https://hooks.slack.com/commands/T123/456/abc')
})

test('a command with no argument still parses — the empty text is meaningful', () => {
  const payload = parseCommandPayload(form({ ...COMPLETE, text: '' }))
  // "/dealcheck" alone is a legitimate invocation; the dispatcher supplies a
  // default prompt rather than refusing it.
  assert.equal(payload?.text, '')
})

test('a body missing anything the reply depends on parses to null', () => {
  for (const missing of ['command', 'team_id', 'user_id', 'response_url']) {
    const fields = { ...COMPLETE } as Record<string, string>
    delete fields[missing]
    assert.equal(parseCommandPayload(form(fields)), null, `${missing} is required`)
  }
  // No response_url means no way to answer — starting a run would burn the
  // user's allowance on something they could never see.
  assert.equal(parseCommandPayload(form({ ...COMPLETE, response_url: '' })), null)
})

test('team_id is readable before the rest of the body is trusted', () => {
  // The route must choose a signing secret before anything in the body may be
  // believed, so this read cannot depend on the payload being well formed.
  assert.equal(teamIdFromCommandBody(form({ team_id: 'T123' })), 'T123')
  assert.equal(teamIdFromCommandBody('not a form at all'), null)
  assert.equal(teamIdFromCommandBody(form({ team_id: '   ' })), null)
  assert.equal(teamIdFromCommandBody(''), null)
})
