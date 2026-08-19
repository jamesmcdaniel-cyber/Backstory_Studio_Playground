import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inboxSubtitle, inboxTitle, proposalPersona } from '../proposal-persona'

test('a new agent or flow applies for the job', () => {
  const agent = proposalPersona({ id: 'p1', kind: 'agent_template' })
  assert.equal(agent.kind, 'applicant')
  assert.equal(agent.action, 'Hire')
  assert.equal(agent.chip, 'Applying · agent')
  assert.equal(proposalPersona({ id: 'p2', kind: 'flow_template' }).chip, 'Applying · flow')
})

test('an improvement is existing staff, never an applicant', () => {
  const persona = proposalPersona({ id: 'p3', kind: 'process_improvement', configuration: { targetId: 'flow-9' } })
  assert.equal(persona.kind, 'staff')
  assert.equal(persona.action, 'Review')
  // Wears the real teammate's face, so the roster and this row agree.
  assert.equal(persona.seed, 'flow-9')
})

test('an improvement with no usable target still gets a stable face', () => {
  for (const configuration of [undefined, null, {}, { targetId: '' }, { targetId: 42 }, ['nope']]) {
    const persona = proposalPersona({ id: 'p4', kind: 'process_improvement', configuration })
    assert.equal(persona.seed, 'p4', `configuration ${JSON.stringify(configuration)} should fall back`)
  }
})

test('an unknown kind is treated as a candidate rather than crashing', () => {
  assert.equal(proposalPersona({ id: 'p5', kind: 'something_new' }).kind, 'applicant')
})

test('the title describes what is actually in the bar', () => {
  assert.equal(inboxTitle(['applicant', 'applicant']), 'Candidates')
  assert.equal(inboxTitle(['staff']), 'Team flags')
  assert.equal(inboxTitle(['applicant', 'staff']), 'Candidates & team flags')
})

test('the subtitle counts each group and gets its plurals right', () => {
  assert.equal(inboxSubtitle(['applicant']), '1 wants to join your team')
  assert.equal(inboxSubtitle(['applicant', 'applicant']), '2 want to join your team')
  assert.equal(inboxSubtitle(['staff']), '1 teammate needs a look')
  assert.equal(inboxSubtitle(['staff', 'staff']), '2 teammates need a look')
  assert.equal(inboxSubtitle(['applicant', 'staff', 'staff']), '1 wants to join · 2 need a look')
  assert.equal(inboxSubtitle(['applicant', 'applicant', 'staff']), '2 want to join · 1 needs a look')
})
