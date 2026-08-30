import test from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'
import { flowTemplateNotesIssues, containsRawToken, type FlowTemplateNotes } from '@/lib/flows/templates/types'
import { repairDraftedNotes, inferBindings, describeGraphForNotes, DRAFT_NOTES_SYSTEM } from '@/lib/flows/templates/draft-notes'
import { GUARDRAIL_RULE } from '@/lib/security/guardrails'
import { UNTRUSTED_DATA_RULE } from '@/lib/security/prompt'

const graph: FlowGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
    { id: 'ask', type: 'ai', data: { aiOp: 'ask', input: 'hi', label: 'Ask the model', note: 'Asks the model.' } },
    { id: 'out', type: 'output', data: { outputs: [{ name: 'answer', value: '{{step.ask.output}}' }], label: 'Return it', note: 'Returns it.' } },
    { id: 'sticky', type: 'note', data: { text: 'a canvas annotation' } },
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'ask' },
    { id: 'e1', source: 'ask', target: 'out' },
  ],
}

const notes: FlowTemplateNotes = {
  objective: 'Ask a question and return the answer.',
  inputs: [],
  steps: [
    { nodeId: 'ask', title: 'Ask the model', what: 'Sends the prompt.' },
    { nodeId: 'out', title: 'Return it', what: 'Returns the answer by name.' },
  ],
  setup: [],
  customize: [],
}

test('a complete notes object has no issues', () => {
  assert.deepEqual(flowTemplateNotesIssues(graph, notes), [])
})

test('an unexplained executable step is an issue', () => {
  const missing = { ...notes, steps: notes.steps.filter((step) => step.nodeId !== 'out') }
  const issues = flowTemplateNotesIssues(graph, missing)
  assert.ok(issues.some((issue) => issue.includes('"out"')), issues.join(' | '))
})

test('a note for a step that is not in the graph is an issue', () => {
  const stray = { ...notes, steps: [...notes.steps, { nodeId: 'ghost', title: 'Ghost step', what: 'Nothing.' }] }
  assert.ok(flowTemplateNotesIssues(graph, stray).some((issue) => issue.includes('Ghost step')))
})

test('a step missing its on-canvas note is an issue', () => {
  const noNote: FlowGraph = {
    ...graph,
    nodes: graph.nodes.map((node) => (node.id === 'ask' ? ({ ...node, data: { ...node.data, note: '' } } as FlowNode) : node)),
  }
  assert.ok(flowTemplateNotesIssues(noNote, notes).some((issue) => issue.includes('on-canvas note')))
})

test('canvas annotations are exempt from the per-step contract', () => {
  // 'sticky' never runs, so it must not be demanded of the notes.
  assert.ok(!flowTemplateNotesIssues(graph, notes).some((issue) => issue.includes('sticky')))
})

test('token syntax anywhere in the notes is an issue', () => {
  const tokenized = { ...notes, objective: 'Return {{step.ask.output}} to the caller.' }
  const issues = flowTemplateNotesIssues(graph, tokenized)
  assert.ok(issues.some((issue) => issue.includes('plain English')), issues.join(' | '))
  assert.ok(containsRawToken('Return {{step.ask.output}}'))
})

test('a binding pointing at a missing step is an issue', () => {
  const issues = flowTemplateNotesIssues(graph, notes, [
    { nodeId: 'ghost', kind: 'agent', label: 'Pick an agent', match: {} },
  ])
  assert.ok(issues.some((issue) => issue.includes('Pick an agent')))
})

test('repair fills in a step the model skipped, in graph order', () => {
  const partial: FlowTemplateNotes = { ...notes, steps: [notes.steps[1]] }
  const repaired = repairDraftedNotes(partial, graph)
  assert.deepEqual(repaired.steps.map((step) => step.nodeId), ['ask', 'out'])
  assert.deepEqual(flowTemplateNotesIssues(graph, repaired), [])
})

test('repair rewrites token syntax the model was told not to write', () => {
  const tokenized: FlowTemplateNotes = {
    ...notes,
    objective: 'Return {{step.ask.output}} and {{trigger.input.name}} to the caller.',
  }
  const repaired = repairDraftedNotes(tokenized, graph)
  assert.equal(repaired.objective, 'Return Ask the model and the name input to the caller.')
  assert.deepEqual(flowTemplateNotesIssues(graph, repaired), [])
})

test('bindings are inferred from filled agent and tool slots', () => {
  const wired: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'run', type: 'agent', data: { agentId: 'agent_7', label: 'Score it', note: 'n' } },
      { id: 'post', type: 'tool', data: { connectionId: 'native:slack', toolName: 'post_message', label: 'Post it', note: 'n' } },
    ],
    edges: [],
  }
  const bindings = inferBindings(wired, [{ id: 'agent_7', name: 'Account Risk Scorer' }])
  assert.deepEqual(bindings.map((binding) => binding.nodeId), ['run', 'post'])
  // The workspace's own agent id is never carried over — only its name, as a hint.
  assert.equal(bindings[0].match.agentName, 'Account Risk Scorer')
  assert.ok(!JSON.stringify(bindings).includes('agent_7'))
  assert.equal(bindings[1].match.provider, 'native:slack')
})

test('the graph description covers every executable step and the connections', () => {
  const described = describeGraphForNotes(graph)
  assert.ok(described.includes('nodeId "ask"'))
  assert.ok(described.includes('nodeId "out"'))
  assert.ok(described.includes('trigger->ask'))
  // The canvas annotation is not a step, so it stays out of the model's brief.
  assert.ok(!described.includes('nodeId "sticky"'))
})

/**
 * DRAFT_NOTES_SYSTEM is exported for these three, and the export is the seam:
 * draftFlowTemplateNotes passes that same identifier to generateStructured and
 * echoes it back as rawParts[0], so asserting on the constant is asserting on
 * what reaches the model. There is nothing to assert on in a reply — a model
 * that never got the boundaries writes notes that look exactly the same.
 */

test('the notes system prompt carries the shared boundaries verbatim', () => {
  assert.ok(
    DRAFT_NOTES_SYSTEM.includes(GUARDRAIL_RULE),
    'these notes are saved with the template and read by whoever installs it next',
  )
  // Byte-identical rather than paraphrased, so guardrails.ts stays the one copy.
  assert.equal(DRAFT_NOTES_SYSTEM.slice(DRAFT_NOTES_SYSTEM.indexOf(GUARDRAIL_RULE)), GUARDRAIL_RULE)
})

test('the boundaries come last, after the fence and the notes contract', () => {
  assert.ok(DRAFT_NOTES_SYSTEM.indexOf(UNTRUSTED_DATA_RULE) < DRAFT_NOTES_SYSTEM.indexOf(GUARDRAIL_RULE))
  assert.ok(DRAFT_NOTES_SYSTEM.indexOf('CRITICAL: never write template token syntax') < DRAFT_NOTES_SYSTEM.indexOf(GUARDRAIL_RULE))
})

test('the graph is described into the user turn, never into the boundaries', () => {
  // The node configs — headers, code bodies, inline values — are the untrusted
  // half. They must not share a turn with the rules they could otherwise argue
  // with, so nothing from describeGraphForNotes belongs in the system prompt.
  assert.ok(!DRAFT_NOTES_SYSTEM.includes(describeGraphForNotes(graph)))
})
