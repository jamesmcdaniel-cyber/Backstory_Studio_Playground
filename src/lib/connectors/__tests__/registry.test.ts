import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BUILTIN_CONNECTORS,
  nangoConnector,
  isSelected,
  isWriteProvider,
  fromNangoProviderKey,
} from '../registry'

const slackBuiltin = BUILTIN_CONNECTORS.find((c) => c.kind === 'builtin' && c.providerId === 'slack')!

test('isSelected matches case-insensitively and by substring', () => {
  assert.equal(isSelected(slackBuiltin, ['Slack']), true)
  assert.equal(isSelected(slackBuiltin, ['slack']), true)
  assert.equal(isSelected(slackBuiltin, ['my-slack-workspace']), true)
  assert.equal(isSelected(slackBuiltin, ['Email', 'Granola']), false)
})

test('nangoConnector resolves a delivery capability to its provider id', () => {
  assert.equal(nangoConnector('gmail')?.providerId, 'nango:gmail')
  assert.equal(nangoConnector('salesforce')?.providerId, 'nango:salesforce')
  assert.equal(nangoConnector('unknown'), undefined)
})

test('isWriteProvider classifies delivery planes as writes and reads as reads', () => {
  assert.equal(isWriteProvider('nango:slack'), true)
  assert.equal(isWriteProvider('nango:gmail'), true)
  assert.equal(isWriteProvider('slack'), true) // built-in Slack
  assert.equal(isWriteProvider('email'), true)
  assert.equal(isWriteProvider('backstory'), false) // People.ai read plane
  assert.equal(isWriteProvider('granola'), false)
  assert.equal(isWriteProvider('github'), false) // unknown provider
})

test('every write connector is a delivery plane; backstory is read', () => {
  const backstory = BUILTIN_CONNECTORS.find((c) => c.providerId === 'backstory')!
  assert.equal(backstory.isWrite, false)
  assert.ok(BUILTIN_CONNECTORS.filter((c) => c.isWrite).every((c) => c.kind === 'builtin' || c.kind === 'nango'))
})

test('nango key derivation is stable and runtime-matchable', () => {
  assert.deepEqual(fromNangoProviderKey('slack-prod'), { key: 'slack', label: 'Slack', slug: 'slack' })
  assert.deepEqual(fromNangoProviderKey('google-mail'), { key: 'gmail', label: 'Gmail', slug: 'gmail' })
  assert.deepEqual(fromNangoProviderKey('google-drive'), { key: 'google_drive', label: 'Google Drive', slug: 'googledrive' })
  assert.deepEqual(fromNangoProviderKey('atlassian'), { key: 'jira', label: 'Jira', slug: 'jira' })
})

test('only Google mail derives to Gmail — runtime resolution matches on this key', () => {
  assert.equal(fromNangoProviderKey('gmail-v2').key, 'gmail')
  assert.equal(fromNangoProviderKey('google_mail').key, 'gmail')
  // A bare 'mail' substring used to claim Gmail, which mislabelled every other
  // mail provider's chip — and would now hand its connection to the Gmail tool.
  assert.equal(fromNangoProviderKey('outlook-mail').key, 'outlook_mail')
  assert.equal(fromNangoProviderKey('fastmail').key, 'fastmail')
})
