import { test } from 'node:test'
import assert from 'node:assert/strict'
import { humanizeToolName, integrationCapabilities } from '../capabilities'

test('tool names humanise to plain English with no raw identifiers', () => {
  assert.equal(humanizeToolName('github_list_repositories', 'github'), 'List repositories')
  assert.equal(humanizeToolName('gmail_send_email', 'gmail'), 'Send email')
  assert.equal(humanizeToolName('google_sheets_append_row', 'google_sheets'), 'Append row')
})

test('capabilities split into reads and writes with descriptions', () => {
  const caps = integrationCapabilities('github')
  assert.ok(caps)
  assert.ok(caps.reads.length > 0)
  for (const item of [...caps.reads, ...caps.writes]) {
    assert.ok(item.label.length > 0)
    assert.ok(!item.label.includes('_'), `raw identifier leaked: ${item.label}`)
    assert.ok(item.description.length > 0)
  }
})

test('config-key variants resolve like the runtime does', () => {
  const canonical = integrationCapabilities('google-mail')
  assert.ok(canonical)
  assert.equal(canonical.provider, 'gmail')
})

test('a connectable provider with no wired tools reports empty lists, not null', () => {
  const caps = integrationCapabilities('some-unknown-provider')
  assert.ok(caps)
  assert.equal(caps.reads.length + caps.writes.length, 0)
})
