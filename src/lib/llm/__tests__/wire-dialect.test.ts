import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMessagesRequest, buildStructuredRequest, extractJson } from '../model-runner'
import { GUARDRAIL_RULE } from '@/lib/security/guardrails'
import { UNTRUSTED_DATA_RULE } from '@/lib/security/prompt'
import { buildAgentSystemPrompt } from '@/features/agents/system-prompt'

/**
 * Qwen runs through DashScope's Anthropic-COMPATIBLE endpoint, which does not
 * implement the API's recent extensions. That matters here because the system
 * prompt is where the guardrails live: an endpoint that rejects or ignores a
 * block-array `system` runs the model with no boundaries and returns an
 * ordinary-looking answer, so nothing downstream can detect it.
 *
 * These tests assert on the REQUEST rather than a reply, since the reply is
 * exactly what cannot distinguish the two cases.
 */

const AGENT_SYSTEM = buildAgentSystemPrompt('Draft a follow-up email.', [])
const TOOLS = [{ name: 'send_email', description: 'Send an email', inputSchema: { type: 'object' } }]
const MESSAGES = [{ role: 'user' as const, content: 'go' }]

const req = (dialect: 'anthropic' | 'compat', model = 'qwen-3.7') =>
  buildMessagesRequest({ model, system: AGENT_SYSTEM, tools: TOOLS, messages: MESSAGES, dialect })

test('compat sends the system prompt as a plain string, guardrails intact', () => {
  const system = req('compat').system
  assert.equal(typeof system, 'string', 'a block array can be dropped by the compat endpoint')
  assert.ok((system as string).includes(GUARDRAIL_RULE))
})

test('both dialects carry byte-identical instruction text', () => {
  const compat = req('compat').system as string
  const full = req('anthropic', 'claude-sonnet-5').system as Array<{ text: string }>
  assert.equal(full[0].text, compat, 'Qwen must not get a weaker or different prompt than Claude')
})

test('compat request carries no Anthropic-only extension fields', () => {
  const params = req('compat') as Record<string, unknown>
  assert.equal(JSON.stringify(params).includes('cache_control'), false)
  assert.equal('thinking' in params, false)
  assert.equal('output_config' in params, false)
})

test('the full dialect keeps caching and adaptive thinking', () => {
  const params = req('anthropic', 'claude-sonnet-5') as Record<string, unknown>
  assert.deepEqual((params.system as Array<{ cache_control: unknown }>)[0].cache_control, { type: 'ephemeral' })
  assert.deepEqual(params.thinking, { type: 'adaptive' })
  // The rolling breakpoint lands on the last message, not on the persisted IR.
  assert.equal(JSON.stringify(params.messages).includes('cache_control'), true)
  assert.equal(JSON.stringify(MESSAGES).includes('cache_control'), false)
})

test('tools are sent identically on both dialects', () => {
  assert.deepEqual(req('compat').tools, req('anthropic', 'claude-sonnet-5').tools)
})

// ── Structured calls ────────────────────────────────────────────────────────

const structured = (dialect: 'anthropic' | 'compat') =>
  buildStructuredRequest({
    system: `Draft a flow.\n\n${UNTRUSTED_DATA_RULE}\n\n${GUARDRAIL_RULE}`,
    user: 'build me something',
    schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    schemaName: 'flow_graph',
    model: dialect === 'compat' ? 'qwen-3.7' : 'claude-sonnet-5',
    dialect,
  })

test('compat structured calls keep the guardrails and instruct the schema instead', () => {
  const params = structured('compat')
  const system = params.system as string
  assert.ok(system.includes(GUARDRAIL_RULE))
  assert.ok(system.includes(UNTRUSTED_DATA_RULE))
  assert.ok(system.includes('flow_graph'), 'the schema contract replaces output_config')
  assert.equal('output_config' in params, false)
  // Guardrails first: the output contract is appended, never prepended over them.
  assert.ok(system.indexOf(GUARDRAIL_RULE) < system.indexOf('Output format'))
})

test('the full dialect constrains structurally and leaves the system prompt alone', () => {
  const params = structured('anthropic')
  assert.equal(params.system, `Draft a flow.\n\n${UNTRUSTED_DATA_RULE}\n\n${GUARDRAIL_RULE}`)
  assert.ok(params.output_config)
})

test('instructed schemas are still closed to extra properties', () => {
  const system = structured('compat').system as string
  assert.ok(system.includes('"additionalProperties":false'))
})

// ── Unwrapping an unconstrained reply ───────────────────────────────────────

test('extractJson unwraps what a compat reply actually looks like', () => {
  assert.equal(extractJson('{"a":1}'), '{"a":1}')
  assert.equal(extractJson('```json\n{"a":1}\n```'), '{"a":1}')
  assert.equal(extractJson('```\n{"a":1}\n```'), '{"a":1}')
  assert.equal(extractJson('Here you go:\n{"a":1}\nHope that helps.'), '{"a":1}')
  assert.equal(extractJson('[{"a":1}]'), '[{"a":1}]')
  // Nested braces survive: the span runs to the LAST closer, not the first.
  assert.equal(extractJson('{"a":{"b":1}}'), '{"a":{"b":1}}')
  // Nothing JSON-shaped is returned untouched, so JSON.parse fails loudly with
  // the model's own words rather than on an empty string.
  assert.equal(extractJson('I cannot do that.'), 'I cannot do that.')
})
