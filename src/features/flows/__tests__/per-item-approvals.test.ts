import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunActionFn, type StepOutcome } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'
import { approvalItem, isRejectedItemOutput, rejectedItemOutput } from '@/lib/flows/item-approval'

/**
 * Per-item approvals at the interpreter seam. The fake action below keeps the
 * adapter's contract (run-action-step.ts): an item that needs sign-off pauses
 * ONLY itself until its decision exists; an approved item returns the write's
 * result; a rejected one is `dropped`; an item that needs no sign-off runs.
 * Resumes are driven the way execute-flow drives them — every settled step
 * row replays from `completed`.
 */

const ITEMS = [
  { name: 'Acme', gated: true },
  { name: 'Globex', gated: true },
  { name: 'Initech', gated: false },
]

const loopGraph: FlowGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: {} },
    { id: 'each', type: 'loop', data: { over: '{{trigger.input}}', body: ['send'] } },
    { id: 'send', type: 'tool', data: { connectionId: 'mcp:crm', toolName: 'update_record', args: '{"name":"{{item.name}}"}' } },
  ],
  edges: [{ id: 'e0', source: 'trigger', target: 'each' }],
}

const perItemGraph: FlowGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: {} },
    { id: 'send', type: 'tool', data: { connectionId: 'mcp:crm', toolName: 'update_record', args: '{"name":"{{item.name}}"}', perItem: { over: '{{trigger.input}}' } } },
  ],
  edges: [{ id: 'e0', source: 'trigger', target: 'send' }],
}

type Decision = 'approved' | 'rejected'

/** A fake engine: per-step decisions, and a record of every real execution. */
function harness() {
  const decisions = new Map<string, Decision>()
  const executed: string[] = []
  const asked: Array<{ stepKey: string; item?: { index: number; count: number; label: string } }> = []
  const runAction: RunActionFn = async (node) => {
    const value = node.item?.value as { name: string; gated: boolean }
    const args = node.config.args as { name: string }
    if (!value.gated) {
      executed.push(args.name)
      return { output: { sent: args.name } }
    }
    const decision = decisions.get(node.id)
    if (decision === 'approved') return { output: { sent: args.name, approved: true } }
    if (decision === 'rejected') {
      const item = approvalItem(node.item!.index, node.item!.count, node.item!.value)
      return { dropped: { reason: 'approval_rejected', output: rejectedItemOutput(`appr-${node.id}`, item) } }
    }
    asked.push({ stepKey: node.id, item: node.item ? approvalItem(node.item.index, node.item.count, node.item.value) : undefined })
    return { waiting: { status: 'waiting_for_approval', question: `Approve ${args.name}?` } }
  }
  return { decisions, executed, asked, runAction }
}

/** What execute-flow would replay on the next resume: every settled leaf row. */
function settled(steps: StepOutcome[], into: Record<string, unknown> = {}): Record<string, unknown> {
  for (const step of steps) {
    if (!step.iterationKey?.includes('#')) continue
    if (step.status === 'succeeded' || step.status === 'skipped') into[step.iterationKey] = step.output
  }
  return into
}

for (const [shape, graph] of [['loop body', loopGraph], ['per-item step', perItemGraph]] as const) {
  test(`${shape}: approved, rejected and auto items each get the right outcome`, async () => {
    const h = harness()
    const run = (completed: Record<string, unknown>) =>
      interpretFlow(graph, ITEMS, { runAgent: async () => ({ output: '' }), runAction: h.runAction, completed })

    // First pass: two items ask, the third needs no sign-off and runs now.
    const first = await run({})
    assert.equal(first.status, 'waiting', 'the run waits while items are undecided')
    assert.deepEqual(h.asked.map((a) => a.stepKey), ['send#0', 'send#1'], 'one approval per gated item')
    assert.deepEqual(h.asked.map((a) => a.item?.label), ['Acme', 'Globex'], 'each approval names its item')
    assert.deepEqual(h.executed, ['Initech'], 'the auto item did not wait for its siblings')

    // Decisions land; the run resumes once.
    h.decisions.set('send#0', 'approved')
    h.decisions.set('send#1', 'rejected')
    const completed = settled(first.steps)
    const second = await run(completed)
    assert.equal(second.status, 'succeeded')
    const container = second.steps.find((s) => (s.nodeId === 'each' || s.nodeId === 'send') && !s.iterationKey?.includes('#') && s.status === 'succeeded')!
    assert.deepEqual(container.output, [{ sent: 'Acme', approved: true }, { sent: 'Initech' }], 'the rejected item is skipped, the rest carry on in order')
    assert.ok(container.warnings?.some((w) => /1 of 3 items was rejected by an approver and skipped/.test(w)), 'the skip is recorded on the container')
    const rejectedRow = second.steps.find((s) => s.iterationKey === 'send#1')!
    assert.equal(rejectedRow.status, 'skipped')
    assert.ok(isRejectedItemOutput(rejectedRow.output), 'the rejected item records why it was skipped')
    assert.deepEqual(h.executed, ['Initech'], 'the auto item replayed — it never ran twice')

    // A later replay keeps the rejected item dropped (never revived).
    const third = await run(settled(second.steps, { ...completed }))
    assert.equal(third.status, 'succeeded')
    const again = third.steps.find((s) => (s.nodeId === 'each' || s.nodeId === 'send') && !s.iterationKey?.includes('#') && s.status === 'succeeded')!
    assert.deepEqual(again.output, [{ sent: 'Acme', approved: true }, { sent: 'Initech' }])
  })
}

test('one decision of two does not finish the run: the undecided item still holds it', async () => {
  const h = harness()
  const first = await interpretFlow(loopGraph, ITEMS, { runAgent: async () => ({ output: '' }), runAction: h.runAction })
  h.decisions.set('send#0', 'approved')
  const partial = await interpretFlow(loopGraph, ITEMS, { runAgent: async () => ({ output: '' }), runAction: h.runAction, completed: settled(first.steps) })
  assert.equal(partial.status, 'waiting')
  assert.equal(partial.waiting?.nodeId, 'send#1')
})
