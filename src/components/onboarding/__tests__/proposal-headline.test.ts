import { test } from 'node:test'
import assert from 'node:assert/strict'
import { proposalHeadline, proposalSubline } from '../proposal-shared'

const improvement = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  title: 'next-up step expects a list but receives non-list input',
  rationale: 'It kept failing the same way.',
  kind: 'process_improvement',
  status: 'open',
  ...over,
})

test('an improvement leads with the name of the thing it is about', () => {
  const proposal = improvement({ targetName: 'Sales Digest' })
  assert.equal(proposalHeadline(proposal), 'Sales Digest')
  // The fault is still shown, just demoted out of the headline.
  assert.equal(proposalSubline(proposal), 'next-up step expects a list but receives non-list input')
})

test('with no resolved name it falls back to the description rather than showing nothing', () => {
  for (const targetName of [undefined, null, '', '   ']) {
    const proposal = improvement({ targetName })
    assert.equal(proposalHeadline(proposal), proposal.title, `targetName ${JSON.stringify(targetName)}`)
    // Nothing was demoted, so there is no second line to repeat it.
    assert.equal(proposalSubline(proposal), null)
  }
})

test('a candidate keeps its own title — that title IS its name', () => {
  const candidate = {
    id: 'p2',
    title: 'Engaged Buyer Re-Engagement',
    rationale: 'why',
    kind: 'flow_template',
    status: 'open',
    targetName: 'ignored',
  }
  assert.equal(proposalHeadline(candidate), 'Engaged Buyer Re-Engagement')
  assert.equal(proposalSubline(candidate), null)
})

test('a surrounding-whitespace name is trimmed, not shown raw', () => {
  assert.equal(proposalHeadline(improvement({ targetName: '  Sales Digest  ' })), 'Sales Digest')
})
