import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  irUser,
  irToolResults,
  irFromAnthropic,
  irFromOpenAI,
  toAnthropicMessages,
  toOpenAIMessages,
  coerceToIR,
  type IRMessage,
} from '../ir'

// A synthetic Anthropic response with a thinking block, text, and a tool call.
const anthropicMessage = {
  content: [
    { type: 'thinking', thinking: 'let me reason', signature: 'sig-abc' },
    { type: 'text', text: 'Looking up ACME.' },
    { type: 'tool_use', id: 'toolu_1', name: 'backstory_get_account', input: { account: 'ACME' } },
  ],
  usage: { input_tokens: 10, output_tokens: 5 },
} as never

const openaiMessage = {
  role: 'assistant',
  content: 'Done.',
  tool_calls: [
    { id: 'call_1', type: 'function', function: { name: 'send', arguments: '{"channel":"#deals"}' } },
  ],
} as never

test('irFromAnthropic keeps neutral fields AND raw native content', () => {
  const ir = irFromAnthropic(anthropicMessage)
  assert.equal(ir.text, 'Looking up ACME.')
  assert.deepEqual(ir.toolCalls, [{ id: 'toolu_1', name: 'backstory_get_account', input: { account: 'ACME' } }])
  assert.equal(ir.raw?.provider, 'anthropic')
})

test('same-provider replay is lossless — thinking blocks survive the round-trip', () => {
  const ir: IRMessage[] = [irUser('go'), irFromAnthropic(anthropicMessage)]
  const [, assistant] = toAnthropicMessages(ir)
  // Verbatim native content: the thinking block (with its signature) is intact.
  assert.deepEqual(assistant.content, (anthropicMessage as { content: unknown }).content)
})

test('cross-provider translation DROPS thinking, keeps text + tool calls', () => {
  const ir: IRMessage[] = [irUser('go'), irFromAnthropic(anthropicMessage)]
  const messages = toOpenAIMessages(ir, 'SYS')
  assert.equal(messages[0].role, 'system')
  const assistant = messages.find((m) => m.role === 'assistant') as {
    content: string | null
    tool_calls?: { function: { name: string } }[]
  }
  assert.equal(assistant.content, 'Looking up ACME.')
  assert.equal(assistant.tool_calls?.length, 1)
  assert.equal(assistant.tool_calls?.[0].function.name, 'backstory_get_account')
  // No thinking leaked into the OpenAI shape.
  assert.ok(!JSON.stringify(assistant).includes('thinking'))
})

test('irFromOpenAI parses tool_calls and JSON arguments', () => {
  const ir = irFromOpenAI(openaiMessage)
  assert.equal(ir.text, 'Done.')
  assert.deepEqual(ir.toolCalls, [{ id: 'call_1', name: 'send', input: { channel: '#deals' } }])
  assert.equal(ir.raw?.provider, 'openai')
})

test('tool results translate to both provider shapes', () => {
  const ir: IRMessage[] = [irToolResults([{ toolCallId: 'toolu_1', content: '{"ok":true}' }])]
  const [anthropic] = toAnthropicMessages(ir)
  assert.equal(anthropic.role, 'user')
  assert.deepEqual(anthropic.content, [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":true}' }])

  const openai = toOpenAIMessages(ir, 'SYS')
  assert.deepEqual(openai[1], { role: 'tool', tool_call_id: 'toolu_1', content: '{"ok":true}' })
})

test('coerceToIR: native Anthropic transcript → IR', () => {
  const native = [
    { role: 'user', content: 'Check ACME.' },
    { role: 'assistant', content: (anthropicMessage as { content: unknown[] }).content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"name":"ACME"}' }] },
  ]
  const ir = coerceToIR(native)
  assert.equal(ir.length, 3)
  assert.deepEqual(ir[0], { role: 'user', content: 'Check ACME.' })
  assert.equal(ir[1].role, 'assistant')
  assert.equal((ir[1] as { raw?: { provider: string } }).raw?.provider, 'anthropic')
  assert.deepEqual(ir[2], { role: 'tool', results: [{ toolCallId: 'toolu_1', content: '{"name":"ACME"}', isError: false }] })
})

test('coerceToIR: native OpenAI transcript merges consecutive tool messages', () => {
  const native = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } },
      { id: 'c2', type: 'function', function: { name: 'b', arguments: '{"x":1}' } },
    ] },
    { role: 'tool', tool_call_id: 'c1', content: 'r1' },
    { role: 'tool', tool_call_id: 'c2', content: 'r2' },
  ]
  const ir = coerceToIR(native)
  assert.equal(ir.length, 3) // user, assistant, ONE merged tool turn
  assert.equal(ir[1].role, 'assistant')
  assert.deepEqual((ir[1] as { toolCalls: unknown }).toolCalls, [
    { id: 'c1', name: 'a', input: {} },
    { id: 'c2', name: 'b', input: { x: 1 } },
  ])
  assert.deepEqual((ir[2] as { results: unknown }).results, [
    { toolCallId: 'c1', content: 'r1', isError: false },
    { toolCallId: 'c2', content: 'r2', isError: false },
  ])
})

test('coerceToIR is idempotent on already-IR input', () => {
  const ir: IRMessage[] = [
    irUser('go'),
    { role: 'assistant', text: 'hi', toolCalls: [], raw: { provider: 'openai', content: {} } },
    irToolResults([{ toolCallId: 'c1', content: 'r' }]),
  ]
  assert.deepEqual(coerceToIR(ir as unknown[]), ir)
})

// Explicit routing is pinned in src/lib/usage/__tests__/model-allowance.test.ts.
