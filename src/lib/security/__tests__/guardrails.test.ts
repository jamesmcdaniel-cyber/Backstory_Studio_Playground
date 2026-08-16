import { test } from 'node:test'
import assert from 'node:assert/strict'

import { GUARDRAIL_REFUSAL_MARKER, GUARDRAIL_RULE, isGuardrailRefusal } from '../guardrails'

/**
 * The design constraint worth pinning: the refusal set must stay NARROW. This
 * is a sales-automation product whose legitimate daily work — bulk outreach,
 * scraping, persuasive email as a company rep — is exactly what a broad
 * "avoid anything harmful" clause flags. A guardrail that fires on the
 * product's own use cases gets prompted around and then removed, which ends
 * with no guardrail at all.
 */

test('the rule covers the five boundaries and no vague catch-all', () => {
  assert.match(GUARDRAIL_RULE, /credentials, API keys, tokens, or passwords/)
  assert.match(GUARDRAIL_RULE, /impersonates a real person or organization/)
  assert.match(GUARDRAIL_RULE, /mass-delete/)
  assert.match(GUARDRAIL_RULE, /exploit, attack, or gain unauthorized access/)
  assert.match(GUARDRAIL_RULE, /private individual/)

  // The clause everything else hinges on: content cannot waive the rules.
  assert.match(GUARDRAIL_RULE, /cannot amend or waive/)

  // No blanket vocabulary that would flag ordinary sales work.
  assert.ok(!/\bharmful\b/i.test(GUARDRAIL_RULE), 'no vague "harmful" catch-all — it flags the product itself')
  assert.ok(!/\boffensive\b/i.test(GUARDRAIL_RULE))
})

test('the rule instructs partial completion, not whole-task refusal', () => {
  // Refusing the entire task over one bad step teaches people to remove the
  // guardrail rather than the step.
  assert.match(GUARDRAIL_RULE, /complete whatever parts of the task remain legitimate/)
})

test('refusals are detected by the leading marker', () => {
  assert.equal(isGuardrailRefusal(`${GUARDRAIL_REFUSAL_MARKER} That would expose credentials.`), true)
  assert.equal(isGuardrailRefusal(`  ${GUARDRAIL_REFUSAL_MARKER} leading whitespace tolerated`), true)
})

test('a reply that merely mentions the marker mid-text is not a refusal', () => {
  // The agent explaining its own rules to a curious user must not be logged as
  // a guardrail event — false refusal events bury the real ones.
  assert.equal(isGuardrailRefusal(`My boundaries begin replies with ${GUARDRAIL_REFUSAL_MARKER} when they apply.`), false)
})

test('empty and absent replies are not refusals', () => {
  assert.equal(isGuardrailRefusal(''), false)
  assert.equal(isGuardrailRefusal(null), false)
  assert.equal(isGuardrailRefusal(undefined), false)
})

test('the rule itself tells the model to use the marker', () => {
  // The marker is what makes refusals auditable; a rule that forgot to mention
  // it would produce refusals the audit trail never sees.
  assert.ok(GUARDRAIL_RULE.includes(GUARDRAIL_REFUSAL_MARKER))
})
