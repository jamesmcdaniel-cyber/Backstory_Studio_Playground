import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acceptOutcome } from '../apply-proposal'

test('an applied recommendation that provisioned an agent lands on that agent', () => {
  const outcome = acceptOutcome('agent_template', { status: 'accepted', kind: 'agent', templateId: 't1', agentId: 'a1' })
  assert.deepEqual(outcome, {
    action: 'navigate',
    href: '/agents?agent=a1',
    message: 'Agent created and ready to run.',
  })
})

test('unconnected integrations are named in the success message, not hidden', () => {
  const outcome = acceptOutcome('agent_template', { agentId: 'a1', missingIntegrations: ['slack', 'gmail'] })
  assert.equal(outcome.action, 'navigate')
  assert.match(outcome.message, /connect slack, gmail/)
})

test('a wired flow lands on the flow', () => {
  const outcome = acceptOutcome('flow_template', { kind: 'flow', templateId: 't1', flowId: 'f1' })
  assert.deepEqual(outcome, { action: 'navigate', href: '/flows/f1', message: 'Flow created and wired — ready to run.' })
})

test('a template with NO live artifact reports failure — never a success the user cannot find', () => {
  const outcome = acceptOutcome('agent_template', { status: 'accepted', kind: 'template', templateId: 't1', provisioned: false })
  assert.equal(outcome.action, 'failed')
  assert.match(outcome.message, /saved in your templates/i)
})

test('process_improvement opens its target alongside, without navigating away', () => {
  assert.deepEqual(acceptOutcome('process_improvement', { open: { targetType: 'flow', targetId: 'f9' } }), {
    action: 'open',
    href: '/flows/f9',
    message: 'Opened what it wants to improve.',
  })
  assert.deepEqual(acceptOutcome('process_improvement', { open: { targetType: 'agent', targetId: 'a9' } }), {
    action: 'open',
    href: '/agents?agent=a9',
    message: 'Opened what it wants to improve.',
  })
})

test('an improvement with no resolvable target still reports, with nothing to open', () => {
  const outcome = acceptOutcome('process_improvement', { open: null })
  assert.deepEqual(outcome, { action: 'open', href: null, message: 'Opened what it wants to improve.' })
})
