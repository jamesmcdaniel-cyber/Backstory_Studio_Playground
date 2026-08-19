import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveGroupRoleLabel, deriveRoleLabel } from '../derive-role'

test('reads the job out of the instructions', () => {
  assert.equal(deriveRoleLabel('Weekly thing', 'Summarize last week and post it to Slack'), 'Summarizer')
  assert.equal(deriveRoleLabel('X', 'Watch the pipeline and flag slipping deals'), 'Pipeline Reporter')
  assert.equal(deriveRoleLabel('X', 'Draft a follow-up email to every new prospect'), 'Outreach Writer')
})

test('prefers the most specific role when several could match', () => {
  // Mentions both research and accounts — the specific pairing wins over the
  // bare "Researcher" fallback further down the list.
  assert.equal(deriveRoleLabel('X', 'Research each account before the call'), 'Deal Researcher')
})

test('a vague agent gets no label rather than a wrong one', () => {
  assert.equal(deriveRoleLabel('Agent 1', 'Do the needful'), null)
  assert.equal(deriveRoleLabel('', ''), null)
  assert.equal(deriveRoleLabel(null, undefined), null)
})

test('falls back to the title when instructions are empty', () => {
  assert.equal(deriveRoleLabel('Renewal tracker', ''), 'Renewal Watcher')
})

test('a group shares a role only when its agents agree', () => {
  assert.equal(deriveGroupRoleLabel(['Summarizer', 'Summarizer']), 'Summarizer')
  assert.equal(deriveGroupRoleLabel(['Summarizer', 'Researcher']), null)
  assert.equal(deriveGroupRoleLabel([null, null]), null)
  assert.equal(deriveGroupRoleLabel(['Researcher', null]), 'Researcher')
})
