import test from 'node:test'
import assert from 'node:assert/strict'
import postcss from 'postcss'
import { ARTIFACT_DESIGN_CSS, ARTIFACT_DESIGN_GUIDANCE } from '../design-system'
import { artifactPageResponse } from '../serve'
import { ARTIFACT_CAPABILITIES } from '../capabilities'
import { buildArtifactRenderPrompt } from '@/features/agents/artifact-renderer'
import { buildArtifactPrompt } from '../service'
import { INTERACTIVE_ARTIFACT_INSTRUCTION } from '@/features/agents/report-format'

test('every design rule is opt-in scoped and requires no external assets', () => {
  const css = postcss.parse(ARTIFACT_DESIGN_CSS)
  css.walkRules(rule => {
    for (const selector of rule.selectors) assert.ok(selector.trim().startsWith('[data-artifact-ui="studio"]'), selector)
  })
  assert.doesNotMatch(ARTIFACT_DESIGN_CSS, /@import|url\(/)
  assert.match(ARTIFACT_DESIGN_CSS, /prefers-reduced-motion/)
  assert.match(ARTIFACT_DESIGN_CSS, /:focus-visible/)
  assert.match(ARTIFACT_DESIGN_CSS, /max-width:480px/)
})

test('HTML and TSX receive the same scoped foundation without weakening their sandbox', async () => {
  for (const content of ['<html><head></head><body><main data-artifact-ui="studio"><button>Action</button></main></body></html>', 'export default function App(){return <main data-artifact-ui="studio"><h1>Workspace</h1></main>}']) {
    const response = artifactPageResponse({ content, kind: 'page' }, 'https://studio.test')
    const html = await response.text()
    assert.equal((html.match(/data-backstory-design-system="1"/g) || []).length, 1)
    assert.ok(html.includes(ARTIFACT_DESIGN_CSS))
    assert.match(response.headers.get('content-security-policy')!, /sandbox/)
    assert.doesNotMatch(response.headers.get('content-security-policy')!, /allow-same-origin/)
  }
})

test('agent, renderer and artifact copilot share task-specific design and real interaction guidance', () => {
  const renderer = buildArtifactRenderPrompt({ objective: 'Build a tracker', request: '', draft: '', evidence: '' })
  const copilot = buildArtifactPrompt({ mode: 'change', title: 'Tracker', content: '<html></html>', message: 'Redesign', chat: [] })
  for (const prompt of [ARTIFACT_CAPABILITIES, renderer.system, copilot]) {
    assert.ok(prompt.includes(ARTIFACT_DESIGN_GUIDANCE))
    assert.match(prompt, /every visible action must perform/)
    assert.match(prompt, /preserve storage keys/)
  }
  assert.doesNotMatch(renderer.system, /Tabs across the top: Summary first/)
  assert.doesNotMatch(INTERACTIVE_ARTIFACT_INSTRUCTION, /3–5 headline KPIs|from js import document/)
  assert.match(INTERACTIVE_ARTIFACT_INSTRUCTION, /task-specific layout/)
})
