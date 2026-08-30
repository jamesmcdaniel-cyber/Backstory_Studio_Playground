import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReflectionPrompt } from '@/lib/flows/reflection-sweep'
import type { FailurePattern } from '@/lib/flows/failure-patterns'
import { GUARDRAIL_RULE } from '@/lib/security/guardrails'
import { UNTRUSTED_DATA_RULE } from '@/lib/security/prompt'

/**
 * The pure half of the reflection sweep — reflection-sweep.db.test.ts covers
 * the DB-backed half and only runs against TEST_DATABASE_URL, which is exactly
 * why the prompt composition is pinned here instead: a boundary that is only
 * checked in CI-mode is a boundary nobody sees break locally.
 *
 * These assert on the composed prompt rather than on a reply, for the reason
 * lib/llm/__tests__/wire-dialect.test.ts states: a model that never received
 * the boundaries answers exactly like one that did.
 */

/**
 * A signature carrying a secret, because that is the realistic case. The
 * detector groups on a normalized error string lifted straight out of a
 * connected system's response, and a 401 body echoing the token that failed is
 * an ordinary thing for one to contain.
 */
const pattern: FailurePattern = {
  stepId: 'fetch',
  kind: 'error',
  signature: '401 unauthorized: bearer sk-live-9f2c said no',
  occurrences: 4,
  runIds: ['run-1', 'run-2', 'run-3'],
  firstSeen: new Date('2026-08-01T00:00:00.000Z'),
  lastSeen: new Date('2026-08-05T00:00:00.000Z'),
}

test('the reflection system prompt carries the shared boundaries verbatim', () => {
  const { system } = buildReflectionPrompt('Nightly brief', pattern)
  assert.ok(
    system.includes(GUARDRAIL_RULE),
    'the rationale is free prose persisted on a proposal the whole workspace reads',
  )
})

test('the boundaries are not a forked local copy', () => {
  const { system } = buildReflectionPrompt('Nightly brief', pattern)
  // Byte-identical, so a change to guardrails.ts reaches this surface without
  // anyone remembering it exists.
  assert.equal(system.slice(system.indexOf(GUARDRAIL_RULE)), GUARDRAIL_RULE)
})

test('the boundaries travel in the system prompt, never beside the failure text', () => {
  const { system, user } = buildReflectionPrompt('Nightly brief', pattern)
  assert.ok(user.includes(pattern.signature), 'the user turn is where the untrusted error lands')
  assert.equal(
    user.includes(GUARDRAIL_RULE),
    false,
    'a boundary sitting next to attacker-influenceable text is one that text can argue with',
  )
  assert.ok(
    system.indexOf(UNTRUSTED_DATA_RULE) < system.indexOf(GUARDRAIL_RULE),
    'fence first, boundaries last — the same order every other surface composes',
  )
})
