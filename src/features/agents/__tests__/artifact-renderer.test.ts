import test from 'node:test'
import assert from 'node:assert/strict'
import { ARTIFACT_RENDER_MODEL, ARTIFACT_RENDER_SPEC, buildArtifactRenderPrompt, evidenceFromTranscript, isDeliverable } from '../artifact-renderer'

test('artifacts are rendered on Opus 5.5 by default', () => {
  assert.equal(ARTIFACT_RENDER_MODEL, process.env.ARTIFACT_RENDER_MODEL?.trim() || 'claude-opus-5-5')
})

test('the spec asks for the ROI-page bar: thesis, story in numbers, tabs, interpretation, drill-down, method', () => {
  for (const part of ['thesis sentence', 'The story in numbers', 'Tabs across the top', 'What this shows', 'Drill-down', 'Method & sources', 'Never invent a number']) {
    assert.ok(ARTIFACT_RENDER_SPEC.includes(part), part)
  }
})

test('the draft and the evidence reach the renderer fenced, with the guardrails in the system prompt', () => {
  const { system, user } = buildArtifactRenderPrompt({ objective: 'Score the reps', request: 'Weekly', draft: '<!doctype html><html><body><h1>Draft</h1></body></html>', evidence: '### crm.search\n[{"rep":"Ana"}]' })
  assert.match(system, /untrusted/i)
  assert.equal((user.match(/<untrusted|BEGIN UNTRUSTED|untrusted_data/gi) ?? []).length > 0 || /fence|untrusted/i.test(user), true)
  assert.ok(user.includes('<h1>Draft</h1>') && user.includes('"rep":"Ana"'))
})

test('evidence is the run\'s tool results, labelled by tool', () => {
  const evidence = evidenceFromTranscript([
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'backstory.top_records', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '[{"account":"Acme","arr":1200000}]' }] },
  ])
  assert.match(evidence, /### backstory\.top_records\n\[\{"account":"Acme"/)
})

test('only a deliverable is rendered — prose and Markdown answers are not', () => {
  assert.equal(isDeliverable('<!doctype html><html><body><h1>Report</h1></body></html>'), true)
  assert.equal(isDeliverable('export default function App() { return <div>x</div> }'), true)
  assert.equal(isDeliverable('Here are the three reps to coach this week: Ana, Bo and Cy.'), false)
})
