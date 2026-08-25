import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripBotMention, resolveMention, type MentionAgent } from '@/lib/slack/mention'

const BOT = 'U0BOT'
const agents: MentionAgent[] = [
  { id: 'a1', name: 'Scout', roleLabel: 'Account research' },
  { id: 'a2', name: 'Ledger', roleLabel: 'Spend review' },
  { id: 'a3', name: 'Pulse', roleLabel: null },
]

test('stripBotMention removes the bot mention wherever it sits', () => {
  assert.equal(stripBotMention(`<@${BOT}> what changed?`, BOT), 'what changed?')
  assert.equal(stripBotMention(`hey <@${BOT}> what changed?`, BOT), 'hey what changed?')
  // Another person's mention is CONTENT, not addressing — it must survive.
  assert.equal(stripBotMention(`<@${BOT}> ask <@U9OTHER> too`, BOT), 'ask <@U9OTHER> too')
})

test('an explicit name resolves that teammate and keeps the rest as the prompt', () => {
  const result = resolveMention({ text: `<@${BOT}> Scout what changed on Acme?`, botUserId: BOT, agents })
  assert.equal(result.kind, 'agent')
  if (result.kind !== 'agent') return
  assert.equal(result.agent.id, 'a1')
  assert.equal(result.prompt, 'what changed on Acme?')
})

test('the name match is case-insensitive and tolerates punctuation', () => {
  for (const text of [`<@${BOT}> scout, what changed?`, `<@${BOT}> SCOUT: what changed?`]) {
    const result = resolveMention({ text, botUserId: BOT, agents })
    assert.equal(result.kind, 'agent', text)
    if (result.kind === 'agent') assert.equal(result.agent.id, 'a1')
  }
})

test('a role label resolves too, so people can address the work', () => {
  const result = resolveMention({ text: `<@${BOT}> spend review how much last month?`, botUserId: BOT, agents })
  assert.equal(result.kind, 'agent')
  if (result.kind === 'agent') {
    assert.equal(result.agent.id, 'a2')
    assert.equal(result.prompt, 'how much last month?')
  }
})

test('a bare mention uses the channel binding', () => {
  const result = resolveMention({ text: `<@${BOT}> what changed?`, botUserId: BOT, agents, boundAgentId: 'a3' })
  assert.equal(result.kind, 'agent')
  if (result.kind === 'agent') {
    assert.equal(result.agent.id, 'a3')
    assert.equal(result.prompt, 'what changed?')
  }
})

test('a bare mention with no binding asks', () => {
  const result = resolveMention({ text: `<@${BOT}> what changed?`, botUserId: BOT, agents })
  assert.equal(result.kind, 'ask')
  if (result.kind === 'ask') {
    assert.equal(result.reason, 'no-name')
    assert.equal(result.candidates.length, 3)
  }
})

test('a named teammate that matches nothing ASKS rather than falling back', () => {
  // Running a different teammate than the one someone named is worse than
  // asking — this is the ruling that keeps the binding from silently
  // overriding an explicit request.
  const result = resolveMention({
    text: `<@${BOT}> Sprocket what changed?`,
    botUserId: BOT,
    agents,
    boundAgentId: 'a3',
  })
  assert.equal(result.kind, 'ask')
  if (result.kind === 'ask') assert.equal(result.reason, 'no-match')
})

test('a bare mention with no text and a binding still runs, with an empty prompt', () => {
  const result = resolveMention({ text: `<@${BOT}>`, botUserId: BOT, agents, boundAgentId: 'a1' })
  assert.equal(result.kind, 'agent')
  if (result.kind === 'agent') assert.equal(result.prompt, '')
})

test('an empty roster is none, not ask — there is nothing to offer', () => {
  const result = resolveMention({ text: `<@${BOT}> hello`, botUserId: BOT, agents: [] })
  assert.equal(result.kind, 'none')
})

test('a binding pointing at an agent no longer in the roster asks', () => {
  // The FK cascade removes bindings for deleted agents, but an agent can also
  // become invisible to this reader. Asking beats running nothing silently.
  const result = resolveMention({ text: `<@${BOT}> hi`, botUserId: BOT, agents, boundAgentId: 'gone' })
  assert.equal(result.kind, 'ask')
})
