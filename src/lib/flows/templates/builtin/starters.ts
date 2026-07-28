import type { FlowTemplateDef } from '@/lib/flows/templates/types'

/**
 * The three original starter flows (formerly `STARTER_TEMPLATES`), now carrying
 * the full notes contract. They use only connection-free node types, so they
 * instantiate ready-to-run in any workspace with no setup at all — the fastest
 * path from "new flow" to "it did something".
 */

export const SUMMARIZE_EXTRACT: FlowTemplateDef = {
  id: 'summarize-extract',
  name: 'Summarize & extract',
  description: 'Take some text and return a summary plus an extracted topic.',
  category: 'Starters',
  icon: '📝',
  integrations: [],
  tags: ['starter', 'ai'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'manual', inputFields: [{ name: 'text', type: 'string', required: true, description: 'The text to work on.' }] } },
      },
      {
        id: 'summary',
        type: 'ai',
        data: {
          aiOp: 'summarize',
          label: 'Summarize the text',
          input: '{{trigger.input.text}}',
          note: 'Condenses whatever you paste in. Add guidance here if you want a particular length or tone.',
        },
      },
      {
        id: 'topic',
        type: 'ai',
        data: {
          aiOp: 'extract',
          label: 'Pull out the topic',
          input: '{{trigger.input.text}}',
          outputFields: [{ name: 'topic', type: 'string' }],
          note: 'Reads the ORIGINAL text, not the summary, so a detail the summary dropped can still be picked up.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return both results',
          outputs: [
            { name: 'summary', value: '{{step.summary.output}}', type: 'text' },
            { name: 'topic', value: '{{step.topic.output.topic}}', type: 'text' },
          ],
          note: 'Names the two results so a webhook caller or a parent flow can read them by name.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'summary' },
      { id: 'e1', source: 'summary', target: 'topic' },
      { id: 'e2', source: 'topic', target: 'out' },
    ],
  },
  bindings: [],
  notes: {
    objective:
      'Turn a block of text into two named results — a short summary and the single topic it is about. Done right, both come back populated on a run with any non-trivial paragraph.',
    inputs: [{ name: 'text', description: 'The text to summarize and classify.', example: 'A meeting transcript, a support thread, a long email.' }],
    steps: [
      { nodeId: 'summary', title: 'Summarize the text', what: 'Condenses the input into a short summary.' },
      {
        nodeId: 'topic',
        title: 'Pull out the topic',
        what: 'Extracts a single topic field as structured data.',
        why: 'It reads the original text rather than the summary, so nothing the summary dropped is lost.',
      },
      { nodeId: 'out', title: 'Return both results', what: 'Returns summary and topic as two named outputs.' },
    ],
    setup: [],
    customize: [
      'Add guidance to Summarize the text to fix a length or tone.',
      'Add more fields to Pull out the topic — sentiment, urgency, named people.',
    ],
    testPlan: 'Run it with a few paragraphs of real text and check both outputs come back non-empty.',
  },
}

export const SCORE_EACH_ITEM: FlowTemplateDef = {
  id: 'score-each-item',
  name: 'Score each item in a list',
  description: 'Run one AI score per item of a list and collect the results — the per-item pattern.',
  category: 'Starters',
  icon: '🔢',
  integrations: [],
  tags: ['starter', 'per-item'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'manual', inputFields: [{ name: 'items', type: 'array', required: true, description: 'The list to score.' }] } },
      },
      {
        id: 'score',
        type: 'ai',
        data: {
          aiOp: 'score',
          label: 'Score every item',
          input: '{{item}}',
          scoreMin: 1,
          scoreMax: 10,
          perItem: { over: '{{trigger.input.items}}', itemError: 'collect', concurrency: 4 },
          note: 'Runs once per item, four at a time. A failing item leaves an error placeholder in its slot instead of failing the whole step.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the scores',
          outputs: [{ name: 'scores', value: '{{step.score.output}}', type: 'list' }],
          note: 'One score object per input item, in the same order.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'score' },
      { id: 'e1', source: 'score', target: 'out' },
    ],
  },
  bindings: [],
  notes: {
    objective:
      'Score every item of a list independently and get one result per item back, in order. This is the per-item fan-out pattern — the building block for anything that processes a batch.',
    inputs: [{ name: 'items', description: 'The list to score. Each item can be text or a record.', example: 'A list of account names, or a list of support tickets.' }],
    steps: [
      {
        nodeId: 'score',
        title: 'Score every item',
        what: 'Rates each item 1-10 with a reason, four items at a time.',
        why: 'Collecting item errors rather than failing means one malformed record cannot lose you the whole batch.',
      },
      { nodeId: 'out', title: 'Return the scores', what: 'Returns the list of score objects, one per input item.' },
    ],
    setup: [],
    customize: [
      'Change the 1-10 range on Score every item to whatever scale you use.',
      'Add scoring guidance so the number means something specific to you.',
      'Raise the four-at-a-time concurrency if your list is long and the model keeps up.',
    ],
    testPlan: 'Run with a short list of three or four items and confirm you get three or four scores back in the same order.',
  },
}

export const SCHEDULED_WAIT: FlowTemplateDef = {
  id: 'scheduled-wait',
  name: 'Scheduled check with a delay',
  description: 'Runs on a schedule, waits, then produces a result — a starting point for reminders and follow-ups.',
  category: 'Starters',
  icon: '⏰',
  integrations: [],
  tags: ['starter', 'schedule'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'schedule', schedule: { type: 'daily', time: '09:00', timezone: 'UTC', isActive: true } } },
      },
      {
        id: 'summarize',
        type: 'ai',
        data: {
          aiOp: 'ask',
          label: 'Write the check-in',
          input: 'Write a short daily check-in.',
          note: 'Replace this prompt with whatever the check-in should actually say.',
        },
      },
      {
        id: 'wait',
        type: 'wait',
        data: {
          mode: 'duration',
          amount: '1',
          unit: 'hours',
          label: 'Hold for an hour',
          note: 'The run pauses here and resumes an hour later. It costs nothing while waiting — it is not a spinning step.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the message',
          outputs: [{ name: 'message', value: '{{step.summarize.output}}', type: 'text' }],
          note: 'The check-in text, available to whatever called this flow.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'summarize' },
      { id: 'e1', source: 'summarize', target: 'wait' },
      { id: 'e2', source: 'wait', target: 'out' },
    ],
  },
  bindings: [],
  notes: {
    objective:
      'A scheduled flow that does something, pauses, then finishes — the skeleton for reminders, follow-ups, and anything with a deliberate delay between steps.',
    inputs: [],
    steps: [
      { nodeId: 'summarize', title: 'Write the check-in', what: 'Generates the message text from a prompt.' },
      {
        nodeId: 'wait',
        title: 'Hold for an hour',
        what: 'Pauses the run for an hour, then resumes.',
        why: 'A wait suspends the run rather than blocking a worker, so a long delay costs nothing while it is pending.',
      },
      { nodeId: 'out', title: 'Return the message', what: 'Returns the generated text as a named output.' },
    ],
    setup: [{ label: 'Set the daily run time and timezone on the trigger', kind: 'value', ref: 'trigger' }],
    customize: [
      'Change the wait from an hour to a day to build a follow-up two steps apart.',
      'Swap the wait to "until a time" to resume at a fixed hour rather than after a delay.',
      'Add a delivery step after the wait to actually send the message somewhere.',
    ],
    testPlan:
      'Run it manually first. The run will go to waiting for an hour — shorten the wait to a minute while testing, then set it back.',
  },
}
