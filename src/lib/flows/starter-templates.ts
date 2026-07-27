import type { FlowGraph } from '@/lib/flows/graph'

/**
 * Built-in starter flow templates for the create path — n8n's "start from a
 * template" without a gallery. Each uses only connection-free node types (ai /
 * data / condition / wait / output), so it's a valid, runnable starting point
 * in any workspace, and showcases the newer capabilities (per-item, wait).
 */
export type StarterTemplate = {
  id: string
  name: string
  description: string
  graph: FlowGraph
}

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    id: 'summarize-extract',
    name: 'Summarize & extract',
    description: 'Take some text and return a summary plus an extracted topic.',
    graph: {
      nodes: [
        { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual', inputFields: [{ name: 'text', type: 'string', required: true }] } } },
        { id: 'summary', type: 'ai', data: { aiOp: 'summarize', input: '{{trigger.input.text}}' } },
        { id: 'topic', type: 'ai', data: { aiOp: 'extract', input: '{{trigger.input.text}}', outputFields: [{ name: 'topic', type: 'string' }] } },
        { id: 'out', type: 'output', data: { outputs: [{ name: 'summary', value: '{{step.summary.output}}' }, { name: 'topic', value: '{{step.topic.output.topic}}' }] } },
      ],
      edges: [
        { id: 'e0', source: 'trigger', target: 'summary' },
        { id: 'e1', source: 'summary', target: 'topic' },
        { id: 'e2', source: 'topic', target: 'out' },
      ],
    },
  },
  {
    id: 'score-each-item',
    name: 'Score each item in a list',
    description: 'Run one AI score per item of a list and collect the results — the per-item pattern.',
    graph: {
      nodes: [
        { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual', inputFields: [{ name: 'items', type: 'array', required: true }] } } },
        { id: 'score', type: 'ai', data: { aiOp: 'score', input: '{{item}}', scoreMin: 1, scoreMax: 10, perItem: { over: '{{trigger.input.items}}', itemError: 'collect' } } },
        { id: 'out', type: 'output', data: { outputs: [{ name: 'scores', value: '{{step.score.output}}' }] } },
      ],
      edges: [
        { id: 'e0', source: 'trigger', target: 'score' },
        { id: 'e1', source: 'score', target: 'out' },
      ],
    },
  },
  {
    id: 'scheduled-wait',
    name: 'Scheduled check with a delay',
    description: 'Runs on a schedule, waits, then produces a result — a starting point for reminders and follow-ups.',
    graph: {
      nodes: [
        { id: 'trigger', type: 'trigger', data: { trigger: { type: 'schedule', schedule: { type: 'daily', time: '09:00', timezone: 'UTC', isActive: true } } } },
        { id: 'summarize', type: 'ai', data: { aiOp: 'ask', input: 'Write a short daily check-in.' } },
        { id: 'wait', type: 'wait', data: { mode: 'duration', amount: '1', unit: 'hours' } },
        { id: 'out', type: 'output', data: { outputs: [{ name: 'message', value: '{{step.summarize.output}}' }] } },
      ],
      edges: [
        { id: 'e0', source: 'trigger', target: 'summarize' },
        { id: 'e1', source: 'summarize', target: 'wait' },
        { id: 'e2', source: 'wait', target: 'out' },
      ],
    },
  },
]
