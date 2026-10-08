import test from 'node:test'
import assert from 'node:assert/strict'
import { __runnerInternals, type ModelTurn } from '../model-runner'

test('on the redacted policy the provider sees placeholders and the run sees real values', async () => {
  const { AgentRunner, egressPolicyCache } = __runnerInternals
  egressPolicyCache.set('org-r', { policy: 'redacted', at: Date.now() })
  let seenSystem = ''
  let seenTranscript = ''
  const provider = {
    providerId: 'anthropic' as const,
    model: 'fake',
    async next(ir: Array<{ role: string }>, system: string): Promise<ModelTurn> {
      seenSystem = system
      seenTranscript = JSON.stringify(ir)
      // The provider replies using the placeholder it was given, as a model would.
      const placeholder = /[a-z]+\d+@redacted\.invalid/.exec(seenTranscript)?.[0] ?? 'none'
      ir.push({ role: 'assistant', text: `Emailing ${placeholder} now.`, toolCalls: [{ id: 't1', name: 'gmail_send', input: { to: placeholder } }], raw: {} } as never)
      return { text: `Emailing ${placeholder} now.`, toolCalls: [{ id: 't1', name: 'gmail_send', input: { to: placeholder } }], usage: { inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1 }, provider: 'anthropic', servedModel: 'fake', latencyMs: 1 }
    },
  }
  const runner = new AgentRunner([provider as never])
  const transcript = runner.start('Email Ada at ada@acme.com about the renewal.')
  const turn = await runner.next(transcript, 'You help ops@acme.com.', [], { organizationId: 'org-r' })
  assert.doesNotMatch(seenSystem, /acme\.com/)
  assert.doesNotMatch(seenTranscript, /acme\.com/, 'nothing real reached the provider')
  assert.match(seenTranscript, /ada1@redacted\.invalid/)
  assert.equal(turn.text, 'Emailing ada@acme.com now.')
  assert.deepEqual(turn.toolCalls[0].input, { to: 'ada@acme.com' }, 'tool inputs are restored before the platform acts')
  assert.equal((transcript as Array<{ text?: string }>).length, 2, 'the restored reply joined the real transcript')
  assert.match(JSON.stringify(transcript), /ada@acme\.com/)
  assert.doesNotMatch(JSON.stringify(transcript), /redacted\.invalid/)
})

test('on the default policy nothing is touched', async () => {
  const { AgentRunner, egressPolicyCache } = __runnerInternals
  egressPolicyCache.set('org-a', { policy: 'allowed', at: Date.now() })
  let seen = ''
  const provider = { providerId: 'anthropic' as const, model: 'fake', async next(ir: unknown[], system: string): Promise<ModelTurn> { seen = system + JSON.stringify(ir); ir.push({ role: 'assistant', text: 'ok', toolCalls: [], raw: {} }); return { text: 'ok', toolCalls: [], usage: { inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1 }, provider: 'anthropic', servedModel: 'fake', latencyMs: 1 } } }
  const runner = new AgentRunner([provider as never])
  await runner.next(runner.start('ada@acme.com'), 'sys', [], { organizationId: 'org-a' })
  assert.match(seen, /ada@acme\.com/)
})
