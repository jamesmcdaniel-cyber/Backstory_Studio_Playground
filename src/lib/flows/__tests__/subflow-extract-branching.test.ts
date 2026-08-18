import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planSubflowExtraction, replaceRangeWithSubflow, type SubflowExtractionPlan } from '../subflow-extract'
import { subflowChildInput } from '../subflow'
import { flowGraphSchema, type FlowGraph, type FlowNode } from '../graph'

/**
 * A tiny single-path interpreter, deliberately ignorant of extraction: it walks
 * a graph the way the executor does (branch edges, joins, the flow-wide symbol
 * table, named outputs, subflow dispatch) so a test can assert that an
 * extracted parent+child pair RUNS the same as the inline steps it replaced.
 */
type Ctx = { input: unknown; vars: Record<string, unknown>; steps: Record<string, unknown>; last: unknown }

function dig(value: unknown, parts: string[]): unknown {
  let cursor = value
  for (const part of parts) {
    if (cursor == null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

function readPath(ctx: Ctx, path: string): unknown {
  const parts = path.split('.')
  if (parts[0] === 'input') return dig(ctx.last, parts.slice(1))
  if (parts[0] === 'trigger' && parts[1] === 'input') return dig(ctx.input, parts.slice(2))
  if (parts[0] === 'var') return ctx.vars[parts[1]]
  if (parts[0] === 'step') return dig(ctx.steps[parts[1]], parts.slice(3))
  return undefined
}

function resolve(ctx: Ctx, template: unknown): unknown {
  if (typeof template !== 'string') return template
  const whole = template.match(/^\{\{\s*([^{}]+?)\s*\}\}$/)
  if (whole) return readPath(ctx, whole[1])
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, path: string) => {
    const value = readPath(ctx, path)
    return value == null ? '' : String(value)
  })
}

function compare(op: string, left: unknown, right: unknown): boolean {
  if (op === 'eq') return String(left) === String(right)
  if (op === 'neq') return String(left) !== String(right)
  if (op === 'contains') return String(left).includes(String(right))
  if (op === 'gt') return Number(left) > Number(right)
  return false
}

type RunResult = { output: unknown; vars: Record<string, unknown> }

function runGraph(graph: FlowGraph, input: unknown, flows: Map<string, FlowGraph>): RunResult {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const ctx: Ctx = { input, vars: {}, steps: {}, last: input }
  let current = graph.nodes.find((node) => node.type === 'trigger')!.id
  let branch: string | undefined
  let named: Record<string, unknown> | undefined
  for (let hop = 0; hop < 200; hop += 1) {
    const outgoing = graph.edges.filter((edge) => edge.source === current)
    const edge = branch === undefined ? outgoing.find((e) => !e.branch) : outgoing.find((e) => e.branch === branch)
    if (!edge) break
    current = edge.target
    branch = undefined
    const node = byId.get(current)!
    if (node.type === 'data') {
      ctx.last = resolve(ctx, (node.data as { input?: string }).input)
    } else if (node.type === 'condition') {
      const clause = node.data.clauses![0]
      branch = compare(clause.op, resolve(ctx, clause.left), resolve(ctx, clause.right)) ? 'true' : 'false'
    } else if (node.type === 'switch') {
      const hit = node.data.cases.find((c) => compare(c.op, resolve(ctx, c.left), resolve(ctx, c.right)))
      branch = hit ? hit.id : 'default'
    } else if (node.type === 'variable') {
      const name = node.data.name
      const value = resolve(ctx, node.data.value ?? '')
      if (node.data.op === 'appendString') ctx.vars[name] = `${String(ctx.vars[name] ?? '')}${String(value)}`
      else if (node.data.op === 'increment') ctx.vars[name] = Number(ctx.vars[name] ?? 0) + Number(value || 1)
      else ctx.vars[name] = value
    } else if (node.type === 'output') {
      named = Object.fromEntries(node.data.outputs.map((entry) => [entry.name, resolve(ctx, entry.value)]))
    } else if (node.type === 'subflow') {
      const inputs = Object.fromEntries(
        Object.entries(node.data.inputs ?? {}).map(([key, value]) => {
          const resolved = resolve(ctx, value)
          return [key, typeof resolved === 'string' ? resolved : String(resolved ?? '')]
        }),
      )
      const fallback = resolve(ctx, node.data.input ?? '')
      const childInput = subflowChildInput(inputs, typeof fallback === 'string' ? fallback : JSON.stringify(fallback))
      const child = runGraph(flows.get(node.data.flowId)!, childInput, flows)
      ctx.last = child.output
    }
    ctx.steps[node.id] = ctx.last
  }
  return { output: named ?? ctx.last, vars: ctx.vars }
}

function planOrThrow(graph: FlowGraph, start: string, end: string): SubflowExtractionPlan {
  const plan = planSubflowExtraction(graph, start, end)
  assert.ok(!('error' in plan), 'error' in plan ? plan.error : '')
  return plan
}

/** Extract [start,end], then return the runnable parent + child pair. */
function extract(graph: FlowGraph, start: string, end: string) {
  const plan = planOrThrow(graph, start, end)
  assert.ok(flowGraphSchema.safeParse(plan.childGraph).success, 'child graph is schema-valid')
  const { graph: parent, nodeId } = replaceRangeWithSubflow(graph, plan, 'child-1', 'Extracted')
  assert.ok(flowGraphSchema.safeParse(parent).success, 'parent graph is schema-valid')
  const flows = new Map<string, FlowGraph>([['child-1', plan.childGraph]])
  return { plan, parent, nodeId, flows }
}

function errorOf(result: SubflowExtractionPlan | { error: string }): string {
  assert.ok('error' in result, 'expected a refusal')
  return (result as { error: string }).error
}

const node = (id: string, type: string, data: unknown): FlowNode => ({ id, type, data }) as FlowNode
const edge = (source: string, target: string, branch?: string) =>
  ({ id: `${source}->${target}${branch ? `:${branch}` : ''}`, source, target, ...(branch ? { branch } : {}) })

/** trigger → a → c(if/else) → [hot | cold] → j(join) → z */
function ifElseGraph(): FlowGraph {
  return {
    nodes: [
      node('trigger', 'trigger', { trigger: { type: 'manual' } }),
      node('a', 'data', { op: 'compose', input: '{{trigger.input.score}}' }),
      node('c', 'condition', { match: 'all', clauses: [{ left: '{{step.a.output}}', op: 'gt', right: '50' }] }),
      node('hot', 'data', { op: 'compose', input: 'hot:{{step.a.output}}' }),
      node('cold', 'data', { op: 'compose', input: 'cold:{{step.a.output}}' }),
      node('j', 'join', { mode: 'passthrough' }),
      node('z', 'data', { op: 'compose', input: 'final:{{input}}' }),
    ],
    edges: [
      edge('trigger', 'a'),
      edge('a', 'c'),
      edge('c', 'hot', 'true'),
      edge('c', 'cold', 'false'),
      edge('hot', 'j'),
      edge('cold', 'j'),
      edge('j', 'z'),
    ],
  }
}

test('a self-contained If/else moves into a subflow and runs identically', () => {
  const original = ifElseGraph()
  const { plan, parent, nodeId, flows } = extract(ifElseGraph(), 'c', 'j')

  // The whole fan-out came along, branch labels intact.
  for (const id of ['c', 'hot', 'cold', 'j']) assert.ok(plan.rangeIds.includes(id), `${id} moved`)
  assert.ok(plan.childGraph.edges.some((e) => e.source === 'c' && e.target === 'hot' && e.branch === 'true'))
  assert.ok(plan.childGraph.edges.some((e) => e.source === 'c' && e.target === 'cold' && e.branch === 'false'))
  assert.ok(plan.childGraph.edges.some((e) => e.source === 'trigger' && e.target === 'c'))
  // The parent is a → subflow → z, with the branch steps gone.
  assert.ok(parent.edges.some((e) => e.source === 'a' && e.target === nodeId))
  assert.ok(parent.edges.some((e) => e.source === nodeId && e.target === 'z'))
  assert.ok(!parent.nodes.some((n) => ['c', 'hot', 'cold', 'j'].includes(n.id)))
  // No variables crossed the boundary, so nothing extra is wired.
  assert.deepEqual(plan.outputVariables, [])
  assert.equal(plan.childInputs, undefined)

  // Both arms produce the same result as the inline run.
  for (const score of [90, 10]) {
    const before = runGraph(original, { score }, new Map())
    const after = runGraph(parent, { score }, flows)
    assert.deepEqual(after.output, before.output, `score ${score}`)
  }
  assert.equal(runGraph(original, { score: 90 }, new Map()).output, 'final:hot:90')
  assert.equal(runGraph(original, { score: 10 }, new Map()).output, 'final:cold:10')
})

/** trigger → a → s(switch) → [red | blue | default] → j(join) → z */
function switchGraph(): FlowGraph {
  return {
    nodes: [
      node('trigger', 'trigger', { trigger: { type: 'manual' } }),
      node('a', 'data', { op: 'compose', input: '{{trigger.input.tier}}' }),
      node('s', 'switch', {
        cases: [
          { id: 'red', label: 'Red', left: '{{step.a.output}}', op: 'eq', right: 'red' },
          { id: 'blue', label: 'Blue', left: '{{step.a.output}}', op: 'eq', right: 'blue' },
        ],
      }),
      node('r1', 'data', { op: 'compose', input: 'RED' }),
      node('b1', 'data', { op: 'compose', input: 'BLUE' }),
      node('d1', 'data', { op: 'compose', input: 'OTHER' }),
      node('j', 'join', { mode: 'passthrough' }),
      node('z', 'data', { op: 'compose', input: 'final:{{input}}' }),
    ],
    edges: [
      edge('trigger', 'a'),
      edge('a', 's'),
      edge('s', 'r1', 'red'),
      edge('s', 'b1', 'blue'),
      edge('s', 'd1', 'default'),
      edge('r1', 'j'),
      edge('b1', 'j'),
      edge('d1', 'j'),
      edge('j', 'z'),
    ],
  }
}

test('a Switch/Join selection moves into a subflow and runs identically on every case', () => {
  const original = switchGraph()
  const { plan, parent, flows } = extract(switchGraph(), 's', 'j')
  for (const id of ['s', 'r1', 'b1', 'd1', 'j']) assert.ok(plan.rangeIds.includes(id), `${id} moved`)
  assert.equal(plan.childGraph.edges.filter((e) => e.source === 's').length, 3)
  assert.ok(plan.childGraph.edges.some((e) => e.source === 's' && e.branch === 'default'))
  for (const tier of ['red', 'blue', 'green']) {
    const before = runGraph(original, { tier }, new Map())
    const after = runGraph(parent, { tier }, flows)
    assert.deepEqual(after.output, before.output, tier)
  }
})

test('a selection whose branch closes outside it is refused, naming the step to extend to', () => {
  // End inside one arm: the other arm still rejoins at "j", which is after it.
  const message = errorOf(planSubflowExtraction(ifElseGraph(), 'c', 'hot'))
  assert.match(message, /isn't self-contained/i)
  assert.match(message, /"Join"/, 'names the step that breaks containment')
  assert.ok(!message.includes('{{'), 'no token syntax in user copy')
})

test('a selection entered from outside is refused, naming the step and where it is entered from', () => {
  // Only one arm plus the join: the join is also fed by the arm left behind.
  const message = errorOf(planSubflowExtraction(ifElseGraph(), 'hot', 'j'))
  assert.match(message, /isn't self-contained/i)
  assert.match(message, /"Join"/)
  assert.match(message, /outside it/i)
})

test('a selection ending on a step that splits into branches is refused', () => {
  const message = errorOf(planSubflowExtraction(ifElseGraph(), 'a', 'c'))
  assert.match(message, /splits into branches/i)
  assert.match(message, /"Condition"/)
})

/**
 * trigger → init(total) → a(append to total) → b(reads total) → z(reads total)
 * Extracting a..b: `total` is read inside but initialized outside → an input;
 * it is written inside and read outside → also an output.
 */
function variableGraph(): FlowGraph {
  return {
    nodes: [
      node('trigger', 'trigger', { trigger: { type: 'manual' } }),
      node('init', 'variable', { op: 'initialize', name: 'total', varType: 'string', value: '{{trigger.input.seed}}' }),
      node('a', 'variable', { op: 'appendString', name: 'total', value: '-a' }),
      node('b', 'data', { op: 'compose', input: 'saw:{{var.total}}' }),
      node('z', 'data', { op: 'compose', input: 'end:{{var.total}}' }),
    ],
    edges: [edge('trigger', 'init'), edge('init', 'a'), edge('a', 'b'), edge('b', 'z')],
  }
}

test('a variable read from outside the selection becomes a subflow input', () => {
  const plan = planOrThrow(variableGraph(), 'a', 'b')
  assert.ok(plan.childInputs, 'per-field inputs are wired')
  assert.equal(plan.childInputs?.total, '{{var.total}}')
  // The child re-declares the variable from its own trigger input, before the
  // moved steps, so every {{var.total}} read inside moves unchanged.
  const receive = plan.childGraph.nodes.find(
    (n) => n.type === 'variable' && (n.data as { op: string; name: string }).name === 'total' && (n.data as { op: string }).op === 'initialize',
  )!
  assert.ok(receive, 'the child initializes the incoming variable')
  assert.equal((receive.data as { value: string }).value, '{{trigger.input.total}}')
  assert.equal((receive.data as { varType: string }).varType, 'string')
  assert.ok(plan.childGraph.edges.some((e) => e.source === 'trigger' && e.target === receive.id))
  assert.ok(plan.childGraph.edges.some((e) => e.source === receive.id && e.target === 'a'))
  // The child declares the field so the subflow step can map it.
  const trigger = plan.childGraph.nodes.find((n) => n.type === 'trigger')!
  const fields = (trigger.data as { trigger: { inputFields: { name: string }[] } }).trigger.inputFields
  assert.ok(fields.some((field) => field.name === 'total'))
  // The pass-through value keeps a field of its own alongside the variables.
  assert.ok(fields.some((field) => field.name === 'input'))
  const moved = plan.childGraph.nodes.find((n) => n.id === 'b')!
  assert.equal((moved.data as { input: string }).input, 'saw:{{var.total}}')
})

test('a variable written for the rest of the flow becomes a subflow output, written back in the parent', () => {
  const original = variableGraph()
  const { plan, parent, nodeId, flows } = extract(variableGraph(), 'a', 'b')
  assert.deepEqual(plan.outputVariables, [{ name: 'total', op: 'set', varType: 'string' }])
  // The child hands it back through a named-output step.
  const output = plan.childGraph.nodes.find((n) => n.type === 'output')!
  const outputs = (output.data as { outputs: { name: string; value: string }[] }).outputs
  assert.equal(outputs.find((o) => o.name === 'total')?.value, '{{var.total}}')
  assert.ok(outputs.some((o) => o.name === 'result'), 'the selection\'s own result rides along')
  assert.ok(plan.childGraph.edges.some((e) => e.source === 'b' && e.target === output.id))
  // The parent writes it back immediately after the subflow step.
  const writeBack = parent.nodes.find((n) => n.type === 'variable' && (n.data as { name: string }).name === 'total' && n.id !== 'init')!
  assert.equal((writeBack.data as { op: string }).op, 'set')
  assert.equal((writeBack.data as { value: string }).value, `{{step.${nodeId}.output.total}}`)
  assert.ok(parent.edges.some((e) => e.source === nodeId && e.target === writeBack.id))
  assert.ok(parent.edges.some((e) => e.source === writeBack.id && e.target === 'z'))

  // End to end: the downstream step sees the same variable value either way.
  const before = runGraph(original, { seed: 'S' }, new Map())
  const after = runGraph(parent, { seed: 'S' }, flows)
  assert.equal(before.output, 'end:S-a')
  assert.deepEqual(after.output, before.output)
  assert.deepEqual(after.vars.total, before.vars.total)
})

test('a variable used only inside the selection moves in wholesale, with no input or output wiring', () => {
  const graph: FlowGraph = {
    nodes: [
      node('trigger', 'trigger', { trigger: { type: 'manual' } }),
      node('a', 'variable', { op: 'initialize', name: 'scratch', varType: 'string', value: 'x' }),
      node('b', 'data', { op: 'compose', input: 'used:{{var.scratch}}' }),
      node('z', 'data', { op: 'compose', input: 'final:{{input}}' }),
    ],
    edges: [edge('trigger', 'a'), edge('a', 'b'), edge('b', 'z')],
  }
  const { plan, parent, flows } = extract(graph, 'a', 'b')
  assert.deepEqual(plan.outputVariables, [])
  assert.equal(plan.childInputs, undefined, 'nothing needs to be passed in')
  assert.equal(plan.childInput, '{{trigger.input}}')
  assert.ok(plan.childGraph.nodes.some((n) => n.id === 'a'), 'the variable step itself moved')
  assert.ok(!plan.childGraph.nodes.some((n) => n.type === 'output'), 'no named outputs are added')
  assert.deepEqual(runGraph(parent, {}, flows).output, runGraph(graph, {}, new Map()).output)
})

test('a variable whose name a subflow field cannot carry is refused by name', () => {
  const graph = variableGraph()
  for (const id of ['init', 'a', 'b', 'z']) {
    const target = graph.nodes.find((n) => n.id === id)!
    const data = target.data as { name?: string; input?: string }
    if (data.name === 'total') data.name = 'grand total'
    if (data.input) data.input = data.input.replace('var.total', 'var.grand total')
  }
  const message = errorOf(planSubflowExtraction(graph, 'a', 'b'))
  assert.match(message, /grand total/)
  assert.match(message, /rename it/i)
})
