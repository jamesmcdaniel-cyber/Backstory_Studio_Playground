import test from 'node:test'
import assert from 'node:assert/strict'
import { ARTIFACT_RENDER_MODEL, ARTIFACT_RENDER_SPEC, buildArtifactRenderPrompt, evidenceFromTranscript, isDeliverable, needsArtifactRender } from '../artifact-renderer'

test('artifacts are rendered on Opus 5.5 by default', () => {
  assert.equal(ARTIFACT_RENDER_MODEL, process.env.ARTIFACT_RENDER_MODEL?.trim() || 'claude-opus-5-5')
})

test('the spec requires task-specific working surfaces, evidence and interaction instead of a fixed report template', () => {
  for (const part of ['primary working surface', 'entity inspector', 'durable records', 'sources, as-of dates and data gaps', 'Never invent a number', 'opt-in offline UI kit']) {
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

test('a deliverable is an answer that IS a document or component, not one that contains some markup', () => {
  // Markdown that shows a small HTML snippet is an answer about HTML.
  const markdownWithSnippet = '## How to embed the chart\n\nPaste this where the chart should go:\n\n```html\n<div class="chart"><p>Pipeline</p></div>\n```\n\nThen reload the page and the chart picks up the latest numbers from the CRM sync.'
  assert.equal(isDeliverable(markdownWithSnippet), false)
  assert.equal(needsArtifactRender(markdownWithSnippet), false)
  // Prose that mentions an inline tag is prose.
  assert.equal(isDeliverable('Wrap each paragraph in <p>like this</p> and the email client keeps the spacing. Ana, Bo and Cy are the reps to coach.'), false)
  assert.equal(isDeliverable('Summary: <p>Win rate rose</p> while <ul><li>Acme</li></ul> slipped, so the forecast moves down.'), false)
  // A full page is, comments and a byte-order mark ahead of it or not.
  const page = '<!doctype html><html><head><title>Q3</title></head><body><h1>Q3 pipeline</h1><table><tr><td>Acme</td></tr></table></body></html>'
  assert.equal(isDeliverable(page), true)
  assert.equal(isDeliverable('\uFEFF<!-- banner -->\n' + page), true)
  assert.equal(isDeliverable('<div class="report"><h1>Q3</h1><p>Win rate rose.</p></div>'), true, 'a document-level root that is the whole answer')
  // A fenced component or page that is the whole answer is, with a short lead-in.
  const component = 'import { useState } from "react"\nexport default function App() { const [n, setN] = useState(0); return <button onClick={() => setN(n + 1)}>{n}</button> }'
  assert.equal(isDeliverable('```tsx\n' + component + '\n```'), true)
  assert.equal(isDeliverable('Here is the tracker you asked for:\n\n```tsx\n' + component + '\n```'), true)
  assert.equal(isDeliverable('Here is the report:\n```html\n' + page + '\n```'), true)
  // ...but not a long explanation with a component somewhere in it.
  assert.equal(isDeliverable('## Approach\n\n' + 'We looked at every account and the activity behind it. '.repeat(8) + '\n\n```tsx\n' + component + '\n```'), false)
})

test('working concise applications do not pay for a second whole-app generation', () => {
  assert.equal(needsArtifactRender('export default function App() { return <button onClick={() => alert("ok")}>Run</button> }'), false)
  assert.equal(needsArtifactRender('<!doctype html><html><body><button onclick="this.textContent=\'Done\'">Run</button></body></html>'), false)
  assert.equal(needsArtifactRender('export default function App() { return <div>'), true)
  assert.equal(needsArtifactRender('<!doctype html><html><body><h1>Draft report</h1></body></html>'), true)
})
