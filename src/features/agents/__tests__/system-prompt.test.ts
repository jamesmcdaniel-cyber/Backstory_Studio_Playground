import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildAgentSystemPrompt } from '../system-prompt.js'
import { getSkill, listSkills } from '../../../lib/skills/compose.js'

describe('buildAgentSystemPrompt', () => {
  it('embeds the raw objective and adds no skill block when none are attached', () => {
    const prompt = buildAgentSystemPrompt('Summarize the weekly sales pipeline.', [])
    assert.ok(prompt.includes('Summarize the weekly sales pipeline.'))
    assert.ok(!prompt.includes('## Attached skill:'))
  })

  it('composes an attached skill into the system prompt (the gap that scheduled runs missed)', () => {
    const fixture = listSkills()[0]
    assert.ok(fixture, 'expected at least one bundled skill to test against')
    const skill = getSkill(fixture.id)
    assert.ok(skill, 'fixture skill should resolve with instructions')

    const prompt = buildAgentSystemPrompt('Do the work.', [fixture.id])
    assert.ok(prompt.includes('Do the work.'))
    assert.ok(prompt.includes(`## Attached skill: ${skill!.name}`))
    assert.ok(prompt.includes(skill!.instructions.slice(0, 40)))
  })

  it('ignores unknown skill ids without throwing', () => {
    const prompt = buildAgentSystemPrompt('Objective.', ['does-not-exist'])
    assert.ok(prompt.includes('Objective.'))
    assert.ok(!prompt.includes('## Attached skill:'))
  })

  it('includes a prompt-injection guardrail: external/retrieved content is data, not instructions', () => {
    const prompt = buildAgentSystemPrompt('Do the work.', [])
    assert.ok(/retrieved_context/.test(prompt), 'names the fenced untrusted block')
    assert.ok(/data,? not instructions|not instructions/i.test(prompt), 'states external content is data, not instructions')
    assert.ok(/never obey|never follow/i.test(prompt), 'forbids obeying embedded instructions')
    // The exfiltration guard: don't send data / take consequential action because
    // external content said to.
    assert.ok(/never send data|contact anyone|consequential/i.test(prompt), 'forbids acting on injected commands')
  })

  it('includes a grounding/refusal instruction so the agent declines instead of fabricating', () => {
    const prompt = buildAgentSystemPrompt('Do the work.', [])
    assert.ok(/ground/i.test(prompt), 'expected a grounding instruction')
    assert.ok(/say so|don.t (?:guess|fabricate)|rather than inventing/i.test(prompt), 'expected an explicit refusal-over-fabrication instruction')
  })

  it('teaches the house HTML report format for report deliverables (and keeps Markdown otherwise)', () => {
    const prompt = buildAgentSystemPrompt('Do the work.', [])
    assert.ok(prompt.includes('REPORT DELIVERABLES'), 'expected the report-format trigger rule')
    assert.ok(prompt.includes('<!doctype html>'), 'expected the self-contained document rule')
    assert.ok(prompt.includes('Executive summary'), 'expected the house skeleton (executive summary section)')
    assert.ok(prompt.includes('Evidence trail'), 'expected the house skeleton (evidence trail section)')
    assert.ok(prompt.includes('prio-high'), 'expected the priority badge classes')
    assert.ok(/Otherwise, format the final response as clean Markdown/.test(prompt), 'Markdown stays the non-report default')
  })

  it('themes reports per artifact family and keeps drafts/advice/Q&A conversational', () => {
    const prompt = buildAgentSystemPrompt('Do the work.', [])
    assert.ok(prompt.includes('REPORT THEME'), 'expected the per-family theme rule')
    assert.ok(prompt.includes('theme-account') && prompt.includes('theme-cockpit'), 'expected named theme classes')
    assert.ok(prompt.includes('REPORT DELIVERABLES vs CONVERSATION'), 'expected the artifact-vs-conversation gate')
    assert.ok(/draft-and-approve/.test(prompt), 'draft loops must stay Markdown')
    assert.ok(prompt.includes('DYNAMIC ELEMENTS'), 'expected the dynamic module guidance')
  })

  it('makes the report document the whole final response, even when it was also delivered elsewhere', () => {
    const prompt = buildAgentSystemPrompt('Do the work.', [])
    assert.ok(/never inside a code fence/i.test(prompt), 'expected the no-code-fence rule')
    assert.ok(/never followed by a Markdown recap/i.test(prompt), 'expected the no-Markdown-recap rule')
    assert.ok(/not an excuse to answer in Markdown/i.test(prompt), 'emailing the report must not downgrade the response')
    assert.ok(/required output shape for this run/i.test(prompt), 'a template contract must override the generic shape')
  })

  it('softens the anti-hedging line to distinguish present from absent information', () => {
    const prompt = buildAgentSystemPrompt('Do the work.', [])
    // The old absolute "Never claim you lack access ..." must be gone.
    assert.ok(!prompt.includes('Never claim you lack access to information that is present in your context'), 'the absolute anti-hedging line should be reworded')
    // The reworded line acknowledges genuinely-absent information.
    assert.ok(/genuinely absent|is genuinely absent|when it is genuinely absent/i.test(prompt), 'expected the softened present-vs-absent wording')
  })
})
