import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FIELD_BY_CODE, issueFieldKey, splitIssuesByField } from '@/lib/flows/issue-fields'
import { validateFlowGraph } from '@/lib/flows/validate'
import type { FlowGraph } from '@/lib/flows/graph'

/**
 * Codes that belong to the flow's SHAPE rather than to any one control, and so
 * are shown in the step-level banner (or the checker) instead of next to a
 * field. Listed explicitly: the coverage test below fails on a new code that is
 * in neither table, which is the only way this map stays current as the
 * validator grows.
 */
const GRAPH_LEVEL = new Set([
  'CYCLE',
  'DANGLING_EDGE',
  'DUPLICATE_NODE_ID',
  'INVALID_NODE_ID',
  'INVALID_TRIGGER',
  'NO_STEPS',
  'UNREACHABLE_STEP',
  'JOIN_NO_INCOMING',
  'MISSING_CONTAINER_STEP',
  // "This step cannot live inside a loop/parallel" — about where the step sits,
  // not about anything the panel can edit.
  'CONTAINER_BRANCHING_UNSUPPORTED',
  'CONTAINER_JOIN_UNSUPPORTED',
  'HUMAN_REVIEW_IN_CONTAINER',
  // About an EDGE, and raised with no nodeId at all — an AI configuration
  // attachment carries no items. There is no field on any step to point at.
  'CONFIGURATION_EDGE',
  // The node's `typeVersion` is one this deployment cannot run. Not fixable by
  // editing a parameter: the flow needs migrating, which is what the migration
  // report is for.
  'UNSUPPORTED_NODE_VERSION',
  'EMPTY_LOOP_BODY',
  'EMPTY_PARALLEL',
  'EMPTY_PARALLEL_BRANCH',
  'ROUTE_NO_ERROR_PATH',
  // Token findings name a step or variable that does not exist — the offending
  // token can sit in any field on the step, so the message carries the location.
  'TOKEN_UNKNOWN_STEP',
  'TOKEN_UNKNOWN_VAR',
  'UNINITIALIZED_VARIABLE',
  'PLACEHOLDER_VALUE',
  // Raised for several different JSON-shaped fields on one step.
  'INVALID_JSON',
  'INVALID_JSON_OBJECT',
])

test('every issue code the validator raises is either owned by a field or graph-level', () => {
  const source = readFileSync(new URL('../validate.ts', import.meta.url), 'utf8')
  const codes = new Set(
    [...source.matchAll(/add\(\s*issues,\s*'(?:error|warning)',\s*'([A-Z_]+)'/g)].map((match) => match[1]),
  )

  assert.ok(codes.size > 50, `expected to find the validator's codes, found ${codes.size}`)
  const orphans = [...codes].filter((code) => !FIELD_BY_CODE[code] && !GRAPH_LEVEL.has(code)).sort()
  assert.deepEqual(
    orphans,
    [],
    `these issue codes point at no config field and are not listed as graph-level:\n  ${orphans.join('\n  ')}`,
  )
})

test('no field mapping names a code the validator cannot raise', () => {
  const source = readFileSync(new URL('../validate.ts', import.meta.url), 'utf8')
  const stale = Object.keys(FIELD_BY_CODE).filter((code) => !source.includes(`'${code}'`)).sort()
  assert.deepEqual(stale, [], `these mapped codes are dead:\n  ${stale.join('\n  ')}`)
})

test('a step missing its URL marks the url field, not the whole step', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: { type: 'manual' } } },
      { id: 'call', type: 'http', position: { x: 0, y: 1 }, data: { method: 'GET', url: '' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'call' }],
  } as unknown as FlowGraph

  const result = validateFlowGraph(graph)
  const stepIssues = result.issues.filter((issue) => issue.nodeId === 'call')
  const { byField } = splitIssuesByField(stepIssues)

  assert.deepEqual(byField.get('url')?.map((issue) => issue.code), ['MISSING_HTTP_URL'])
})

test('a graph-shaped finding stays in the step banner', () => {
  assert.equal(issueFieldKey({ code: 'CYCLE' }), undefined)
  const { byField, rest } = splitIssuesByField([
    { level: 'error', code: 'CYCLE', message: 'loop' },
    { level: 'error', code: 'MISSING_TOOL', message: 'tool' },
  ])
  assert.equal(byField.size, 1)
  assert.deepEqual(rest.map((issue) => issue.code), ['CYCLE'])
})

test('an issue with no code at all is kept, not dropped', () => {
  const { rest } = splitIssuesByField([{ level: 'warning', message: 'legacy caller' }])
  assert.equal(rest.length, 1)
})
