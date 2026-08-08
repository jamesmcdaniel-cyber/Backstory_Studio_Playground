import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TOOL_QUICK_CONFIGS,
  parseAgentToolSettings,
  quickConfigForChip,
  quickConfigForProvider,
  scopeDescriptionSuffix,
  scopeSummary,
  toolScopeViolation,
} from '@/lib/connectors/tool-quick-config'

const slackConfig = TOOL_QUICK_CONFIGS.find((c) => c.key === 'slack')!
const githubConfig = TOOL_QUICK_CONFIGS.find((c) => c.key === 'github')!

test('quickConfigForChip matches chip keys across planes, not unrelated tools', () => {
  assert.equal(quickConfigForChip('Slack')?.key, 'slack')
  assert.equal(quickConfigForChip('slack')?.key, 'slack')
  assert.equal(quickConfigForChip('github')?.key, 'github')
  assert.equal(quickConfigForChip('Gmail'), undefined)
  assert.equal(quickConfigForChip('HTTP API'), undefined)
})

test('quickConfigForProvider covers builtin and nango provider ids', () => {
  assert.equal(quickConfigForProvider('slack')?.key, 'slack')
  assert.equal(quickConfigForProvider('nango:slack')?.key, 'slack')
  assert.equal(quickConfigForProvider('nango:github')?.key, 'github')
  assert.equal(quickConfigForProvider('granola'), undefined)
})

test('parseAgentToolSettings normalizes and rejects junk without throwing', () => {
  assert.deepEqual(parseAgentToolSettings(undefined), {})
  assert.deepEqual(parseAgentToolSettings('nope'), {})
  assert.deepEqual(parseAgentToolSettings([1, 2]), {})
  const parsed = parseAgentToolSettings({
    slack: [
      { id: ' C012 ', label: ' #general ' },
      { id: 'C034' }, // label falls back to id
      { label: '#no-id' }, // dropped: no id
      'garbage',
    ],
    github: 'not-a-list', // dropped: not an array
  })
  assert.deepEqual(parsed, {
    slack: [
      { id: 'C012', label: '#general' },
      { id: 'C034', label: 'C034' },
    ],
  })
})

test('option mappers normalize live items and skip malformed ones', () => {
  assert.deepEqual(slackConfig.mapItem({ id: 'C012', name: 'general' }), { id: 'C012', label: '#general' })
  assert.equal(slackConfig.mapItem({ id: 'C012' }), null)
  assert.equal(slackConfig.mapItem('junk'), null)
  assert.deepEqual(githubConfig.mapItem({ full_name: 'acme/web' }), { id: 'acme/web', label: 'acme/web' })
  assert.equal(githubConfig.mapItem({ name: 'web' }), null)
})

test('scopeSummary pluralizes around the empty-means-all sentinel', () => {
  assert.equal(scopeSummary(slackConfig, []), 'All channels')
  assert.equal(scopeSummary(slackConfig, [{ id: 'C1', label: '#a' }]), '1 channel')
  assert.equal(scopeSummary(githubConfig, [{ id: 'a/b', label: 'a/b' }, { id: 'a/c', label: 'a/c' }]), '2 repositories')
})

test('scopeDescriptionSuffix appears only for restricted, matching providers', () => {
  const settings = { slack: [{ id: 'C012', label: '#general' }] }
  assert.equal(scopeDescriptionSuffix('nango:gmail', settings), null)
  assert.equal(scopeDescriptionSuffix('nango:slack', {}), null)
  assert.equal(scopeDescriptionSuffix('nango:github', settings), null)
  const suffix = scopeDescriptionSuffix('nango:slack', settings)
  assert.ok(suffix?.includes('#general (C012)'))
  assert.ok(suffix?.includes('blocked'))
})

test('slack scope guard allows by id or name and blocks the rest', () => {
  const settings = { slack: [{ id: 'C012AB3CD', label: '#revenue' }] }
  const check = (args: unknown) =>
    toolScopeViolation({ provider: 'nango:slack', toolName: 'slack_post_message', args, settings })
  assert.equal(check({ channel: 'C012AB3CD', text: 'hi' }), null)
  assert.equal(check({ channel: 'c012ab3cd', text: 'hi' }), null)
  assert.equal(check({ channel: '#revenue', text: 'hi' }), null)
  assert.equal(check({ channel: 'Revenue', text: 'hi' }), null)
  assert.ok(check({ channel: '#random', text: 'hi' })?.includes('#random'))
  // Calls without a channel argument target the account, not a resource.
  assert.equal(check({ user: 'U123', text: 'dm' }), null)
  // Unrestricted settings never block.
  assert.equal(
    toolScopeViolation({ provider: 'slack', toolName: 'post_message', args: { channel: '#x' }, settings: {} }),
    null,
  )
  // The builtin Slack plane ('slack' provider) is governed by the same scope.
  assert.ok(
    toolScopeViolation({ provider: 'slack', toolName: 'post_message', args: { channel: '#x' }, settings })?.includes('#x'),
  )
})

test('github scope guard checks owner/repo pairs case-insensitively', () => {
  const settings = { github: [{ id: 'Acme/Web', label: 'Acme/Web' }] }
  const check = (args: unknown) =>
    toolScopeViolation({ provider: 'nango:github', toolName: 'github_list_pull_requests', args, settings })
  assert.equal(check({ owner: 'acme', repo: 'web' }), null)
  assert.ok(check({ owner: 'acme', repo: 'api' })?.includes('acme/api'))
  // Repo-less calls (e.g. github_list_repositories) pass through.
  assert.equal(check({ owner: 'acme' }), null)
  assert.equal(check({}), null)
  // A Slack-only restriction does not constrain GitHub.
  assert.equal(
    toolScopeViolation({
      provider: 'nango:github',
      toolName: 'github_list_pull_requests',
      args: { owner: 'x', repo: 'y' },
      settings: { slack: [{ id: 'C1', label: '#a' }] },
    }),
    null,
  )
})
