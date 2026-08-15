import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyRunDataRedaction } from '../run-data-guard'
import { REDACTED } from '@/lib/logging/redact'

/**
 * This sits in the Prisma extension precisely so it cannot be bypassed by a new
 * executor write path. The tests therefore pin the SHAPES of Prisma write args
 * rather than any particular call site — create, update, updateMany, upsert and
 * createMany all reach the database, and one of them being missed is the whole
 * failure mode this replaces.
 */

const TOKEN_BODY = {
  access_token: `ya29.${'A'.repeat(28)}`,
  expires_in: 3600,
}

test('step output is redacted on create', () => {
  const out = applyRunDataRedaction('FlowRunStep', 'create', {
    data: { id: 'step-1', output: { body: TOKEN_BODY } },
  }) as { data: { id: string; output: { body: Record<string, unknown> } } }

  assert.equal(out.data.output.body.access_token, REDACTED)
  assert.equal(out.data.output.body.expires_in, 3600, 'non-secret fields survive')
  assert.equal(out.data.id, 'step-1', 'unrelated fields are untouched')
})

test('step output is redacted on update — the path the executor actually uses most', () => {
  const out = applyRunDataRedaction('FlowRunStep', 'update', {
    where: { id: 'step-1' },
    data: { status: 'succeeded', output: { body: TOKEN_BODY } },
  }) as { where: unknown; data: { status: string; output: { body: Record<string, unknown> } } }

  assert.equal(out.data.output.body.access_token, REDACTED)
  assert.equal(out.data.status, 'succeeded')
})

test('updateMany is covered — the executor finishes steps with it', () => {
  const out = applyRunDataRedaction('FlowRunStep', 'updateMany', {
    where: { id: 'step-1', status: 'running' },
    data: { output: { token: ['sk', 'ant', 'api03', 'A'.repeat(24)].join('-') } },
  }) as { data: { output: Record<string, unknown> } }

  assert.equal(out.data.output.token, REDACTED)
})

test('upsert redacts BOTH payloads', () => {
  // A create-side leak is just as permanent as an update-side one, and it is
  // the half that is easy to forget.
  const out = applyRunDataRedaction('FlowRunStep', 'upsert', {
    where: { id: 'step-1' },
    create: { output: { apiKey: 'literal-secret-value' } },
    update: { output: { apiKey: 'literal-secret-value' } },
  }) as { create: { output: Record<string, unknown> }; update: { output: Record<string, unknown> } }

  assert.equal(out.create.output.apiKey, REDACTED)
  assert.equal(out.update.output.apiKey, REDACTED)
})

test('createMany redacts every row in the array', () => {
  const out = applyRunDataRedaction('FlowRunStep', 'createMany', {
    data: [
      { output: { password: 'one' } },
      { output: { password: 'two' } },
    ],
  }) as { data: Array<{ output: Record<string, unknown> }> }

  assert.equal(out.data[0].output.password, REDACTED)
  assert.equal(out.data[1].output.password, REDACTED)
})

test('code-step logs are redacted — console.log of a token is a real leak path', () => {
  const out = applyRunDataRedaction('FlowRunStep', 'update', {
    data: { logs: [`fetched with Bearer ${['sk', 'ant', 'api03', 'B'.repeat(24)].join('-')}`] },
  }) as { data: { logs: string[] } }

  assert.ok(!out.data.logs[0].includes('api03-BBB'))
  assert.ok(out.data.logs[0].includes('fetched with'), 'the log stays useful')
})

test('the run trigger payload is redacted — an inbound webhook body may carry a token', () => {
  const out = applyRunDataRedaction('FlowRun', 'create', {
    data: { trigger: { type: 'webhook', headers: { authorization: 'Bearer abcdefghijklmnop' } } },
  }) as { data: { trigger: { type: string; headers: Record<string, unknown> } } }

  assert.equal(out.data.trigger.headers.authorization, REDACTED)
  assert.equal(out.data.trigger.type, 'webhook')
})

// ── Not doing more than it should ──────────────────────────────────────────

test('reads are untouched', () => {
  // Redacting a where clause would silently change which rows match.
  const args = { where: { output: { equals: 'anything' } } }
  assert.equal(applyRunDataRedaction('FlowRunStep', 'findMany', args), args)
})

test('models outside the run-data set are untouched', () => {
  const args = { data: { output: { apiKey: 'literal' } } }
  assert.equal(applyRunDataRedaction('Flow', 'update', args), args)
  assert.equal(applyRunDataRedaction('AgentExecution', 'create', args), args)
})

test('a write that touches no run-data field returns the SAME object', () => {
  // Identity, not deep equality: a partial update must not be widened into a
  // full one, and allocating a copy on every write would be wasteful.
  const args = { where: { id: 'step-1' }, data: { status: 'running' } }
  assert.equal(applyRunDataRedaction('FlowRunStep', 'update', args), args)
})

test('null and undefined run-data fields are left alone', () => {
  // undefined means "not being written". Replacing it would turn a partial
  // update into one that nulls a column it never meant to touch.
  const args = { data: { status: 'failed', output: undefined } }
  const out = applyRunDataRedaction('FlowRunStep', 'update', args) as { data: Record<string, unknown> }
  assert.equal('output' in out.data && out.data.output === undefined, true)
})

test('an unknown model with no args does not throw', () => {
  assert.doesNotThrow(() => applyRunDataRedaction(undefined, 'update', undefined))
  assert.doesNotThrow(() => applyRunDataRedaction('FlowRunStep', 'update', null))
})
