import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeProposal, proposalSchema } from '../[id]/chat/shared'

/**
 * Which agent an applied assistant proposal lands on. Getting this wrong in the
 * "new" direction spawns clutter; getting it wrong in the "update" direction
 * overwrites the agent the user is looking at — so `update` is the default and
 * `new` has to be earned.
 *
 * Lives here rather than beside `shared.ts`: the test runner globs the paths
 * `find` hands it, and a `[id]` segment reads as a glob character — a test
 * under the dynamic-route directory is silently collected as zero tests.
 */

const shape = (raw: unknown) => normalizeProposal(proposalSchema.catch(null).parse(raw))

test('a full agent definition marked "new" targets a separate agent', () => {
  const proposal = shape({
    summary: 'Create an agent that retrieves the full demo story field.',
    target: 'new',
    title: '2nd Watch demo story lookup',
    description: 'Retrieves the complete SalesAI_Demo_Story__c value.',
    instructions: 'Fetch and return the complete, untruncated field value.',
    model: null,
    integrations: null,
    skills: null,
    schedule: null,
  })
  assert.equal(proposal?.target, 'new')
  assert.equal(proposal?.title, '2nd Watch demo story lookup')
  // Tools are absent on purpose: the new agent inherits them from the source.
  assert.equal('integrations' in (proposal ?? {}), false)
  assert.equal('skills' in (proposal ?? {}), false)
})

test('a "new" proposal with no instructions falls back to updating this agent', () => {
  const proposal = shape({ summary: 'Rename it.', target: 'new', title: 'Renamed agent' })
  assert.equal(proposal?.target, 'update', 'nothing a separate agent could run on — stay on this one')
})

test('ordinary change requests default to updating this agent', () => {
  for (const raw of [
    { summary: 'Run daily at 9am.', schedule: { type: 'daily', time: '09:00', timezone: 'UTC', isActive: true } },
    { summary: 'Tighten the instructions.', target: 'update', instructions: 'Be terse.' },
    { summary: 'Tighten the instructions.', instructions: 'Be terse.' },
    { summary: 'Add Slack.', target: null, integrations: ['slack'] },
  ]) {
    assert.equal(shape(raw)?.target, 'update', `defaults to update: ${raw.summary}`)
  }
})

test('an empty or absent proposal stays null', () => {
  assert.equal(shape(null), null)
  assert.equal(shape({ summary: 'Nothing to do.', target: 'new' }), null, 'a target alone is not a proposal')
  assert.equal(shape({ summary: 'Blank fields.', title: '   ', instructions: '  ' }), null)
})
