import { test } from 'node:test'
import assert from 'node:assert/strict'
import { proposalInstructions, proposalSummary, type ProposalCard } from '@/components/onboarding/proposal-shared'
import { AUTOMATION_ASSET_CONTRACT, AUTOMATION_ASSET_CONTRACT_MARKER } from '@/lib/templates/automation-assets'

function card(overrides: Partial<ProposalCard> = {}): ProposalCard {
  return {
    id: 'p1',
    title: 'Account Health Brief',
    rationale: 'You run Salesforce and Gmail together every week.',
    kind: 'agent_template',
    status: 'open',
    ...overrides,
  }
}

test('instructions drop the server-appended asset contract', () => {
  const proposal = card({
    configuration: { instructions: `Do the thing.\n\n${AUTOMATION_ASSET_CONTRACT}` },
  })
  const text = proposalInstructions(proposal)
  assert.equal(text, 'Do the thing.')
  assert.ok(!text.includes(AUTOMATION_ASSET_CONTRACT_MARKER))
})

test('summary keeps a short instruction verbatim', () => {
  const proposal = card({ configuration: { instructions: 'Draft a weekly account brief and email it.' } })
  assert.equal(proposalSummary(proposal), 'Draft a weekly account brief and email it.')
})

test('summary cuts a long instruction at a sentence boundary', () => {
  const first = 'Summarize each target account from Backstory sales intelligence and deliver a personalized outreach email.'
  const proposal = card({
    configuration: { instructions: `${first} Success = each targeted account produces a factual brief. ${'Step plan detail. '.repeat(40)}` },
  })
  const summary = proposalSummary(proposal)
  assert.ok(summary.length <= 180, `expected a short line, got ${summary.length} chars`)
  assert.ok(summary.startsWith(first))
  assert.ok(summary.endsWith('.'))
})

test('summary ellipsizes when no sentence break lands in range', () => {
  const proposal = card({ configuration: { instructions: `${'word '.repeat(100)}end.` } })
  const summary = proposalSummary(proposal)
  assert.ok(summary.length <= 181)
  assert.ok(summary.endsWith('…'))
})

test('improvement proposals summarize their notes', () => {
  const proposal = card({
    kind: 'process_improvement',
    configuration: { notes: 'Ground the upsell engine in dedicated account data.' },
  })
  assert.equal(proposalSummary(proposal), 'Ground the upsell engine in dedicated account data.')
})

test('a proposal with no configuration summarizes to nothing', () => {
  assert.equal(proposalSummary(card()), '')
})
