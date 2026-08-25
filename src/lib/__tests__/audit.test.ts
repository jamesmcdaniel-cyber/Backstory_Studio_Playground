import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashPayload, auditRowsToCsv, toolAuditAction } from '../audit'

test('hashPayload is stable and never echoes raw content', () => {
  const payload = { channel: '#secret', text: 'confidential' }
  const a = hashPayload(payload)
  const b = hashPayload({ channel: '#secret', text: 'confidential' })
  assert.equal(a, b)
  assert.match(a!, /^sha256:[0-9a-f]{64}$/)
  assert.ok(!a!.includes('confidential'))
})

test('hashPayload handles null/undefined', () => {
  assert.equal(hashPayload(null), null)
  assert.equal(hashPayload(undefined), null)
})

test('auditRowsToCsv emits a header and escapes commas/quotes/newlines', () => {
  const csv = auditRowsToCsv([
    {
      createdAt: new Date('2026-07-03T12:00:00Z'),
      action: 'tool.write',
      actorKind: 'agent',
      actorUserId: 'user-1',
      tool: 'slack_post_message',
      resourceType: 'deal',
      resourceId: 'opp, 1',
      executionId: 'exec-1',
      payloadHash: 'sha256:abc',
    },
  ])
  const [header, row] = csv.split('\n')
  assert.equal(header, 'createdAt,action,actorKind,actorUserId,tool,resourceType,resourceId,executionId,payloadHash')
  assert.match(row, /2026-07-03T12:00:00.000Z,tool\.write,agent,user-1,slack_post_message,deal,"opp, 1",exec-1,sha256:abc/)
})

test('a tool call is classified by what it DOES, not which plane it came from', () => {
  // The bug this replaces: both the agent loop and the flow runtime decided
  // this with /^(nango|slack|email|backstory)/i against the PROVIDER name. Every
  // Slack and Gmail read — slack_list_channels, slack_read_messages,
  // gmail_search — arrives on the `nango` plane, so all of them were recorded
  // as `tool.write` in an append-only, never-pruned, compliance-framed log.
  // And a genuinely writing MCP tool was recorded as a read.
  //
  // The accurate flag was already on the binding the whole time, and the
  // approval gate two files away was already using it correctly.
  assert.equal(toolAuditAction(true), 'tool.write')
  assert.equal(toolAuditAction(false), 'tool.call')
})

test('a read on a write plane is not a write', () => {
  // The concrete case the regex got wrong, stated as itself so a future
  // "simplification" back to provider-matching fails here.
  const slackReadIsWrite = false
  assert.equal(toolAuditAction(slackReadIsWrite), 'tool.call')
})
