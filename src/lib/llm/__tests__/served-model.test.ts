import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveServedModel } from '../model-runner'

/**
 * Regression for the headline path: it used to send `qwenModel(target.model)`
 * to the provider but record `target.model` (the UI-facing alias) in the
 * ledger — so a Qwen headline call was billed/attributed to a model id that
 * was never actually served whenever QWEN_MODEL overrides the alias.
 * resolveServedModel is the single mapping both the request and the ledger
 * record now share, so they can never diverge again.
 */
test('claude target: the served model IS the requested id', () => {
  assert.equal(resolveServedModel({ target: 'claude', model: 'claude-sonnet-5' }), 'claude-sonnet-5')
})

test('qwen target: the served model is the alias when QWEN_MODEL is unset', () => {
  const original = process.env.QWEN_MODEL
  delete process.env.QWEN_MODEL
  try {
    assert.equal(resolveServedModel({ target: 'qwen', model: 'qwen-3.7' }), 'qwen-3.7')
  } finally {
    if (original === undefined) delete process.env.QWEN_MODEL
    else process.env.QWEN_MODEL = original
  }
})

test('qwen target: QWEN_MODEL overrides the UI alias with the exact endpoint id', () => {
  const original = process.env.QWEN_MODEL
  process.env.QWEN_MODEL = 'qwen3.7-plus'
  try {
    const served = resolveServedModel({ target: 'qwen', model: 'qwen-3.7' })
    assert.equal(served, 'qwen3.7-plus')
    assert.notEqual(served, 'qwen-3.7', 'the served id must differ from the alias — this is the case the old code got wrong')
  } finally {
    if (original === undefined) delete process.env.QWEN_MODEL
    else process.env.QWEN_MODEL = original
  }
})
