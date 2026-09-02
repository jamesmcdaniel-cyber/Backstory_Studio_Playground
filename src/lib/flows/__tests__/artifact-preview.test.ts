import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectArtifact } from '../artifact-preview'

test('a gmail send is an email artifact, body and headers intact', () => {
  const artifact = detectArtifact('gmail_send_email', {
    to: 'a@example.com', cc: 'b@example.com', subject: 'Weekly sweep', body: '<h1>Report</h1>',
  })
  assert.deepEqual(artifact, {
    kind: 'email', to: 'a@example.com', cc: 'b@example.com', bcc: undefined,
    subject: 'Weekly sweep', body: '<h1>Report</h1>',
  })
})

test('an email-shaped input is recognised even without a tool name', () => {
  const artifact = detectArtifact(null, { to: 'a@example.com', subject: 'Hi', body: 'Plain text.' })
  assert.equal(artifact?.kind, 'email')
})

test('a slack post is a message artifact', () => {
  const artifact = detectArtifact('slack_post_message', { channel: '#revenue', text: 'Pipeline is up' })
  assert.deepEqual(artifact, { kind: 'message', channel: '#revenue', text: 'Pipeline is up' })
})

test('a salesforce create is a record artifact with its fields', () => {
  const artifact = detectArtifact('salesforce_create_record', { sobject: 'Task', fields: { Subject: 'Call', Status: 'Open' } })
  assert.deepEqual(artifact, { kind: 'record', object: 'Task', fields: { Subject: 'Call', Status: 'Open' } })
})

test('an input that only looks vaguely mail-ish is not an artifact', () => {
  assert.equal(detectArtifact(null, { to: 'a@example.com' }), null) // no body/subject
  assert.equal(detectArtifact(null, { subject: 'x', body: 1234 }), null) // body not text
  assert.equal(detectArtifact(null, 'a string'), null)
  assert.equal(detectArtifact(null, null), null)
})

test('a tool name wins over an ambiguous shape', () => {
  // A slack tool whose args happen to carry a `body` key must still preview as
  // a message, not an email.
  const artifact = detectArtifact('slack_post_message', { channel: '#x', text: 'hi', body: 'ignore me' })
  assert.equal(artifact?.kind, 'message')
})
