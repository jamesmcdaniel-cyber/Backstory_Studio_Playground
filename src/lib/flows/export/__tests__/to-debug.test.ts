import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '@/lib/flows/graph'
import type { FlowValidationResult } from '@/lib/flows/validate'
import { nativeFlowPackageSchema } from '@/lib/flows/native-package'
import { flowToDebugPackage } from '../to-debug'

const graph: FlowGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
    { id: 'a1', type: 'agent', data: { agentId: '', input: '', label: 'Build brief' } },
    { id: 't1', type: 'tool', data: { connectionId: '', toolName: '', label: '' } },
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'a1' },
    { id: 'e1', source: 'a1', target: 't1' },
  ],
}

const validation: FlowValidationResult = {
  ok: false,
  errors: [
    { level: 'error', code: 'MISSING_AGENT', message: 'Pick an agent for this step.', nodeId: 'a1' },
    { level: 'error', code: 'MISSING_TOOL_CONNECTION', message: 'Pick a tool connection.', nodeId: 't1' },
  ],
  warnings: [
    { level: 'warning', code: 'EMPTY_AGENT_INPUT', message: 'This agent step has no input.', nodeId: 'a1' },
  ],
  issues: [],
}
validation.issues = [...validation.errors, ...validation.warnings]

const flow = { name: 'Readiness report', description: 'Weekly readiness.', folder: '', visibility: 'shared', graph }

test('flowToDebugPackage embeds the findings with step labels', () => {
  const pkg = flowToDebugPackage(flow, validation)
  assert.equal(pkg.format, 'backstory.flow.v1')
  assert.equal(pkg.debug.issues.length, 3)
  const agentIssue = pkg.debug.issues.find((i) => i.code === 'MISSING_AGENT')
  assert.equal(agentIssue?.nodeId, 'a1')
  assert.equal(agentIssue?.step, 'Build brief (agent)')
  // An unlabeled step falls back to its type.
  const toolIssue = pkg.debug.issues.find((i) => i.code === 'MISSING_TOOL_CONNECTION')
  assert.equal(toolIssue?.step, 'tool')
  assert.ok(pkg.debug.summary.includes('2 errors') && pkg.debug.summary.includes('1 warning'))
  assert.ok(pkg.debug.assistantInstructions.includes('debug.issues'))
})

test('debug package round-trips through the native import schema', () => {
  const pkg = flowToDebugPackage(flow, validation)
  // The import side must accept the file untouched — the debug block is
  // stripped, the flow parses, nothing about the extra key is an error.
  const parsed = nativeFlowPackageSchema.safeParse(JSON.parse(JSON.stringify(pkg)))
  assert.ok(parsed.success)
  assert.equal(parsed.data!.flow.name, 'Readiness report')
  assert.equal(parsed.data!.flow.graph.nodes.length, 3)
  assert.ok(!('debug' in parsed.data!))
})

test('a clean flow exports a no-problems summary', () => {
  const clean: FlowValidationResult = { ok: true, errors: [], warnings: [], issues: [] }
  const pkg = flowToDebugPackage(flow, clean)
  assert.equal(pkg.debug.issues.length, 0)
  assert.ok(pkg.debug.summary.includes('no problems'))
})
