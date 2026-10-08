import test from 'node:test'
import assert from 'node:assert/strict'
import { CHAT_MODELS, CHAT_SURFACE_DEFAULTS, chatModelLabel, isChatModel, resolveChatModel } from '../models'
import { computeCostUsd } from '@/lib/usage/pricing'

test('the chat list is exactly the four offered models', () => {
  assert.deepEqual(CHAT_MODELS.map((model) => model.id), ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1'])
})

test('a requested model is used only when it is on the list', () => {
  assert.equal(resolveChatModel('claude-opus-5-5', 'copilot'), 'claude-opus-5-5')
  assert.equal(resolveChatModel('claude-sonnet-5', 'copilot'), CHAT_SURFACE_DEFAULTS.copilot, 'retired from the list: falls back')
  assert.equal(resolveChatModel('gpt-5', 'librarian'), 'claude-haiku-5-5')
  assert.equal(resolveChatModel(undefined, 'assistant'), 'claude-sonnet-5-5')
  assert.equal(resolveChatModel({ id: 'claude-fable-5-1' }, 'artifact'), 'claude-opus-5-5', 'artifacts are built and changed on Opus 5.5 by default')
  assert.equal(isChatModel('claude-fable-5-1'), true)
})

test('every surface default is on the list', () => {
  for (const model of Object.values(CHAT_SURFACE_DEFAULTS)) assert.ok(isChatModel(model), model)
})

test('every offered model has a price, so usage is never costed as unknown', () => {
  for (const model of CHAT_MODELS) {
    const { priceVersion, costUsd } = computeCostUsd('anthropic', model.id, { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 })
    assert.notEqual(priceVersion, 'unknown', model.id)
    assert.ok(costUsd > 0, model.id)
  }
  assert.equal(chatModelLabel('claude-opus-5-5'), 'Opus 5.5')
})
