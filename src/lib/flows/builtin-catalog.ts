import type { StepType } from '@/lib/flows/mutate'
import type { AiOp, DataOp, VariableOp } from '@/lib/flows/graph'

/** One pickable item in the Add-trigger/Add-action catalog. */
export type PickerLeaf = {
  id: string
  label: string
  description: string
  mode: 'action' | 'trigger' | 'both'
  stepType?: StepType
  seed?: { agentId?: string; connectionId?: string; toolName?: string; label?: string; variableOp?: VariableOp; dataOp?: DataOp; aiOp?: AiOp; codeLanguage?: 'javascript' | 'python' }
  triggerType?: 'manual' | 'schedule' | 'webhook' | 'signal' | 'poll'
}

export type PickerGroup = {
  id: string
  label: string
  description: string
  mode: 'action' | 'trigger' | 'both'
  children: PickerLeaf[]
}

/** Built-in tool groups with MS-style drill-in. */
export const BUILTIN_GROUPS: PickerGroup[] = [
  {
    id: 'http',
    label: 'HTTP',
    description: 'Call APIs and webhooks with full request control.',
    mode: 'action',
    children: [
      { id: 'http-request', label: 'HTTP', description: 'Send a request to any API endpoint and use the response.', mode: 'action', stepType: 'http' },
      { id: 'http-webhook-out', label: 'HTTP Webhook', description: 'Post a payload to an external webhook URL.', mode: 'action', stepType: 'http', seed: { label: 'Webhook' } },
    ],
  },
  {
    id: 'control',
    label: 'Control',
    description: 'Branch, loop, and stop the flow.',
    mode: 'action',
    children: [
      { id: 'control-condition', label: 'Condition', description: 'Route down different paths based on a rule.', mode: 'action', stepType: 'condition' },
      { id: 'control-switch', label: 'Switch', description: 'Route to one of several cases, with a default path.', mode: 'action', stepType: 'switch' },
      { id: 'control-loop', label: 'For each', description: 'Run steps once for every item in a list.', mode: 'action', stepType: 'loop' },
      { id: 'control-parallel', label: 'Parallel branches', description: 'Run independent branches at the same time.', mode: 'action', stepType: 'parallel' },
      { id: 'control-wait', label: 'Wait', description: 'Pause for a delay, until a time, or until an external system calls back.', mode: 'action', stepType: 'wait' },
      { id: 'control-stop', label: 'Stop flow', description: 'End the flow early with an optional message.', mode: 'action', stepType: 'stop' },
    ],
  },
  {
    id: 'flow-basics',
    label: 'Flow basics',
    description: 'Return named results and merge branches back together.',
    mode: 'action',
    children: [
      { id: 'flow-output', label: 'Output', description: 'Return one or more named results to whatever called this flow.', mode: 'action', stepType: 'output' },
      { id: 'flow-join', label: 'Join / merge branches', description: 'Merge branches back into one path, combine their items into a list, or join records by a matching field.', mode: 'action', stepType: 'join' },
      { id: 'flow-subflow', label: 'Run a flow', description: 'Run another flow as one step and use its result.', mode: 'action', stepType: 'subflow' },
      { id: 'flow-note', label: 'Note', description: 'A sticky note that documents the flow in place. Never runs.', mode: 'action', stepType: 'note' },
    ],
  },
  {
    id: 'data-operation',
    label: 'Data operations',
    description: 'Shape, parse, and filter data between steps.',
    mode: 'action',
    children: [
      { id: 'data-compose', label: 'Compose', description: 'Pass a value through so later steps can reuse it.', mode: 'action', stepType: 'data', seed: { dataOp: 'compose' } },
      { id: 'data-parse-json', label: 'Parse JSON', description: 'Turn JSON text into structured data for later steps.', mode: 'action', stepType: 'data', seed: { dataOp: 'parseJson' } },
      { id: 'data-join', label: 'Join', description: 'Combine a list into one text value with a separator.', mode: 'action', stepType: 'data', seed: { dataOp: 'join' } },
      { id: 'data-csv-table', label: 'Create CSV table', description: 'Turn a list of records into a CSV table.', mode: 'action', stepType: 'data', seed: { dataOp: 'csvTable' } },
      { id: 'data-html-table', label: 'Create HTML table', description: 'Turn a list of records into an HTML table.', mode: 'action', stepType: 'data', seed: { dataOp: 'htmlTable' } },
      { id: 'data-filter-array', label: 'Filter array', description: 'Keep only the list items that match your conditions.', mode: 'action', stepType: 'data', seed: { dataOp: 'filterArray' } },
      { id: 'data-select', label: 'Select', description: 'Map each list item to a new shape with the fields you choose.', mode: 'action', stepType: 'data', seed: { dataOp: 'select' } },
      { id: 'data-split', label: 'Split text', description: 'Split text at a separator into a list.', mode: 'action', stepType: 'data', seed: { dataOp: 'split' } },
      { id: 'data-replace', label: 'Find & replace', description: 'Replace every occurrence of some text with other text.', mode: 'action', stepType: 'data', seed: { dataOp: 'replace' } },
      { id: 'data-get-item', label: 'Get item', description: 'Take one item from a list by its position.', mode: 'action', stepType: 'data', seed: { dataOp: 'getItem' } },
      { id: 'data-flatten', label: 'Flatten list', description: 'Turn nested lists into one flat list.', mode: 'action', stepType: 'data', seed: { dataOp: 'flatten' } },
      { id: 'data-trim', label: 'Trim list', description: 'Remove items from the start or end of a list.', mode: 'action', stepType: 'data', seed: { dataOp: 'trim' } },
      { id: 'data-parse-csv', label: 'Parse CSV', description: 'Turn CSV text into a list of records for later steps.', mode: 'action', stepType: 'data', seed: { dataOp: 'parseCsv' } },
      { id: 'data-sort', label: 'Sort', description: 'Order a list by one of its fields.', mode: 'action', stepType: 'data', seed: { dataOp: 'sort' } },
      { id: 'data-limit', label: 'Limit', description: 'Keep only the first or last few items of a list.', mode: 'action', stepType: 'data', seed: { dataOp: 'limit' } },
      { id: 'data-remove-duplicates', label: 'Remove duplicates', description: 'Drop repeated items, keeping the first of each.', mode: 'action', stepType: 'data', seed: { dataOp: 'removeDuplicates' } },
      { id: 'data-aggregate', label: 'Aggregate', description: 'Collapse a list into a single value.', mode: 'action', stepType: 'data', seed: { dataOp: 'aggregate' } },
      { id: 'data-summarize', label: 'Summarize', description: 'Group records by a field and total, average, or count them.', mode: 'action', stepType: 'data', seed: { dataOp: 'summarize' } },
      { id: 'data-format-date', label: 'Format a date', description: 'Write a date in the pattern you choose.', mode: 'action', stepType: 'data', seed: { dataOp: 'formatDate' } },
      { id: 'data-date-shift', label: 'Add or subtract time', description: 'Shift a date by an amount of time.', mode: 'action', stepType: 'data', seed: { dataOp: 'dateShift' } },
      { id: 'data-date-diff', label: 'Time between dates', description: 'Count the time between two dates.', mode: 'action', stepType: 'data', seed: { dataOp: 'dateDiff' } },
      { id: 'data-date-part', label: 'Pick a date part', description: 'Pull the year, month, weekday, or another part from a date.', mode: 'action', stepType: 'data', seed: { dataOp: 'datePart' } },
      { id: 'data-rename-keys', label: 'Rename fields', description: 'Rename fields on a record or every record in a list.', mode: 'action', stepType: 'data', seed: { dataOp: 'renameKeys' } },
      { id: 'data-markdown-to-html', label: 'Markdown to HTML', description: 'Convert Markdown text into HTML.', mode: 'action', stepType: 'data', seed: { dataOp: 'markdownToHtml' } },
      { id: 'data-html-to-markdown', label: 'HTML to Markdown', description: 'Convert HTML into Markdown text.', mode: 'action', stepType: 'data', seed: { dataOp: 'htmlToMarkdown' } },
      { id: 'data-xml-parse', label: 'Parse XML', description: 'Turn XML text into structured data for later steps.', mode: 'action', stepType: 'data', seed: { dataOp: 'xmlParse' } },
      { id: 'data-xml-build', label: 'Create XML', description: 'Build an XML document from a record.', mode: 'action', stepType: 'data', seed: { dataOp: 'xmlBuild' } },
      { id: 'data-columnar-to-records', label: 'Columns to records', description: 'Turn a columns-and-rows API response (like a Snowflake SQL result) into a list of records.', mode: 'action', stepType: 'data', seed: { dataOp: 'columnarToRecords' } },
    ],
  },
  {
    id: 'code',
    label: 'Code',
    description: 'Run custom JavaScript or Python against flow data.',
    mode: 'action',
    children: [
      { id: 'code-javascript', label: 'JavaScript', description: 'Transform data with custom JavaScript in an isolated process.', mode: 'action', stepType: 'code', seed: { label: 'JavaScript', codeLanguage: 'javascript' } },
      { id: 'code-python', label: 'Python', description: 'Transform data with custom Python in an isolated process.', mode: 'action', stepType: 'code', seed: { label: 'Python', codeLanguage: 'python' } },
    ],
  },
  {
    id: 'variable',
    label: 'Variables',
    description: 'Declare and update named values shared across the flow.',
    mode: 'action',
    children: [
      { id: 'variable-initialize', label: 'Initialize variable', description: 'Declare a named, typed value before other steps use it.', mode: 'action', stepType: 'variable', seed: { variableOp: 'initialize' } },
      { id: 'variable-set', label: 'Set variable', description: 'Replace the value of a variable initialized earlier.', mode: 'action', stepType: 'variable', seed: { variableOp: 'set' } },
      { id: 'variable-increment', label: 'Increment variable', description: 'Add to a number variable — by 1 unless you set an amount.', mode: 'action', stepType: 'variable', seed: { variableOp: 'increment' } },
      { id: 'variable-decrement', label: 'Decrement variable', description: 'Subtract from a number variable — by 1 unless you set an amount.', mode: 'action', stepType: 'variable', seed: { variableOp: 'decrement' } },
      { id: 'variable-append-array', label: 'Append to array variable', description: 'Add an item to the end of an array variable.', mode: 'action', stepType: 'variable', seed: { variableOp: 'appendArray' } },
      { id: 'variable-append-string', label: 'Append to string variable', description: 'Add text to the end of a string variable.', mode: 'action', stepType: 'variable', seed: { variableOp: 'appendString' } },
    ],
  },
  {
    id: 'human-review',
    label: 'Human review',
    description: 'Pause the flow and ask a person.',
    mode: 'action',
    children: [
      { id: 'human-review-request', label: 'Request information', description: 'Pause the flow, ask someone a question, and use their reply in later steps.', mode: 'action', stepType: 'humanReview' },
    ],
  },
]

/** AI capabilities shown first in action mode. */
// 'Run a prompt' (inline, no saved agent) returns when prompt-mode exists in the graph schema.
export const AI_CAPABILITY_LEAVES: PickerLeaf[] = [
  { id: 'ai-ask', label: 'Ask AI', description: 'Give AI a prompt and some input, get its answer for later steps.', mode: 'action', stepType: 'ai', seed: { aiOp: 'ask' } },
  { id: 'ai-extract', label: 'Extract data', description: 'Pull named fields out of any text as structured data.', mode: 'action', stepType: 'ai', seed: { aiOp: 'extract' } },
  { id: 'ai-categorize', label: 'Categorize', description: 'Sort input into one of the categories you define.', mode: 'action', stepType: 'ai', seed: { aiOp: 'categorize' } },
  { id: 'ai-summarize', label: 'Summarize', description: 'Condense long input into a short summary.', mode: 'action', stepType: 'ai', seed: { aiOp: 'summarize' } },
  { id: 'ai-score', label: 'Score', description: 'Rate input on a numeric scale with a reason.', mode: 'action', stepType: 'ai', seed: { aiOp: 'score' } },
  { id: 'ai-knowledge', label: 'Search knowledge', description: 'Find the most relevant passages from your uploaded documents.', mode: 'action', stepType: 'knowledge' },
  { id: 'ai-run-agent', label: 'Run an agent', description: 'Run one of your agents and pass its response to the next step.', mode: 'action', stepType: 'agent' },
  { id: 'ai-custom-agent', label: 'Custom agent', description: 'Define a new agent right on this step — instructions, chat model, memory, and tools.', mode: 'action', stepType: 'agent' },
]

/** Trigger-mode top level: the four ways a flow can start. */
export const TRIGGER_LEAVES: PickerLeaf[] = [
  { id: 'trigger-manual', label: 'Manually trigger a flow', description: 'Start it from the builder or with typed inputs.', mode: 'trigger', triggerType: 'manual' },
  { id: 'trigger-schedule', label: 'Schedule', description: 'Run on a recurrence you define.', mode: 'trigger', triggerType: 'schedule' },
  { id: 'trigger-poll', label: 'When new items appear in an app', description: 'Check a connected app on a schedule and start for each new item.', mode: 'trigger', triggerType: 'poll' },
  { id: 'trigger-webhook', label: 'When an HTTP request is received', description: 'Start when an external system posts to a secret URL.', mode: 'trigger', triggerType: 'webhook' },
  { id: 'trigger-signal', label: 'When a signal fires', description: 'Start from an in-platform event, like another flow completing.', mode: 'trigger', triggerType: 'signal' },
]

export function searchCorpus(leaf: PickerLeaf): string {
  return `${leaf.label} ${leaf.description}`.toLowerCase()
}
