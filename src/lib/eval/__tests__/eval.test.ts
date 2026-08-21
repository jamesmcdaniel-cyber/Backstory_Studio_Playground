import { test } from 'node:test'
import assert from 'node:assert/strict'
import { replayScripted, runLoop, cannedDispatch, checkTrajectory } from '../harness'
import { ScriptedRunner } from '../scripted-runner'
import { fixtureFromTranscript } from '../from-transcript'
import { judgeTrajectory } from '../judge'
import { fixtures } from '../fixtures'
import { createModelRunner } from '@/lib/llm/model-runner'

// ── Deterministic scripted replay (offline, always runs in CI) ───────────────
for (const fixture of fixtures) {
  test(`fixture (scripted): ${fixture.name} meets its trajectory expectations`, async () => {
    const trajectory = await replayScripted(fixture)
    const failures = checkTrajectory(trajectory, fixture.expect)
    assert.equal(failures.length, 0, failures.join('; '))
  })
}

test('runLoop dispatches tool calls, feeds results back, and ends on a final answer', async () => {
  const runner = new ScriptedRunner([
    { toolCalls: [{ name: 'lookup', input: { q: 'x' } }] },
    { text: 'All done.' },
  ])
  const t = await runLoop(runner, { name: 'x', system: 's', input: 'go' }, () => ({ content: '{"hit":true}', isError: false }))
  assert.equal(t.finalText, 'All done.')
  assert.deepEqual(t.toolsCalled, ['lookup'])
  assert.equal(t.hitMaxTurns, false)
  assert.equal(t.turns[0].results[0].content, '{"hit":true}')
})

test('runLoop reports hitMaxTurns when the model never stops calling tools', async () => {
  // A script that keeps calling a tool every turn; maxTurns caps it.
  const runner = new ScriptedRunner(Array.from({ length: 10 }, () => ({ toolCalls: [{ name: 'loop' }] })))
  const t = await runLoop(runner, { name: 'x', system: 's', input: 'go', maxTurns: 3 }, () => ({ content: '{}', isError: false }))
  assert.equal(t.hitMaxTurns, true)
  assert.equal(t.turns.length, 3)
})

test('checkTrajectory flags missing tools, forbidden tools, and missing substrings', () => {
  const trajectory = {
    finalText: 'posted to #deals',
    turns: [],
    toolsCalled: ['nango_send_slack_message'],
    toolErrors: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
    rawUsage: { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
    hitMaxTurns: false,
  }
  const failures = checkTrajectory(trajectory, {
    toolsCalled: ['backstory_get_account'],
    toolsNotCalled: ['nango_send_slack_message'],
    finalTextIncludes: ['ACME'],
    noToolErrors: true,
  })
  assert.equal(failures.length, 4)
})

test('fixtureFromTranscript lifts an Anthropic transcript into a replayable fixture', async () => {
  const transcript = [
    { role: 'user', content: 'Check ACME and post an update.' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Looking up ACME.' },
        { type: 'tool_use', id: 'tu_1', name: 'backstory_get_account', input: { account: 'ACME' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"name":"ACME"}' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ACME looks healthy.' }] },
  ]
  const fixture = fixtureFromTranscript({
    name: 'from-transcript-smoke',
    system: 'You are a test agent.',
    transcript,
    expect: { toolsCalled: ['backstory_get_account'], finalTextIncludes: ['healthy'] },
  })
  assert.equal(fixture.input, 'Check ACME and post an update.')
  const trajectory = await replayScripted(fixture)
  assert.deepEqual(checkTrajectory(trajectory, fixture.expect), [])
  assert.equal(trajectory.turns[0].results[0].content, JSON.stringify({ name: 'ACME' }))
})

// ── LLM-judge (live; skipped when no provider key is configured) ─────────────
const hasKey = Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY)
for (const fixture of fixtures.filter((f) => f.rubric)) {
  test(
    `fixture (live judge): ${fixture.name} satisfies its rubric`,
    { skip: hasKey ? false : 'no ANTHROPIC_API_KEY/OPENAI_API_KEY configured' },
    async () => {
      const runner = createModelRunner(fixture.model)
      const trajectory = await runLoop(runner, fixture, cannedDispatch(fixture.toolResponses))
      const failures = checkTrajectory(trajectory, fixture.expect)
      assert.equal(failures.length, 0, `structural: ${failures.join('; ')}`)
      const verdict = await judgeTrajectory(fixture.rubric!, trajectory)
      assert.ok(verdict.pass, `judge failed (${verdict.score}): ${verdict.reasoning}`)
    },
  )
}
