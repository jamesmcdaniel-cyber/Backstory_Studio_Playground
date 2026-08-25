import type { FlowNode } from '@/lib/flows/graph'

/**
 * The option-collection system: n8n's `collection` parameter, as our own.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * Measured against n8n's HTTP node, ours declares 21 parameters to their 86 —
 * and ours reads as the busier panel. The difference is not how much either
 * holds and it is not gating (our conditional ratio is higher than theirs). It
 * is that n8n folds twelve groups into `collection` / `fixedCollection`
 * containers, so a parameter does not exist on screen until you add it, and
 * everything optional lives behind ONE control named `Options`.
 *
 * Ours were spread across four different disclosure mechanisms with four
 * different names — two `<details>`, an "Advanced parameters" panel, and a
 * per-item section at the top of the panel. Four lids, none of them the same
 * shape, is why a smaller panel looked larger.
 *
 * ── The semantics ─────────────────────────────────────────────────────────
 * An option is ADDED when its key holds a value, and REMOVED by clearing that
 * key back to `undefined`. That is not a new convention: `advancedParamsSetCount`
 * has always read "set" exactly this way, so every option that already existed
 * keeps its stored meaning and no graph needs migrating.
 *
 * Pure. The renderer owns controls; this owns which options a node has, which
 * of them apply right now, and which are currently added.
 */

export type NodeOptionControl =
  | { kind: 'select'; choices: Array<{ value: string; label: string }> }
  | { kind: 'number'; min?: number; max?: number; unit?: 'seconds' | 'count' }
  | { kind: 'boolean'; onLabel: string; offLabel: string }
  | { kind: 'text'; placeholder?: string }
  /** Rendered by the panel — a nested editor the collection only shows/hides. */
  | { kind: 'custom' }

export type NodeOption = {
  /** The `node.data` key this option reads and writes. */
  key: string
  label: string
  description?: string
  control: NodeOptionControl
  /**
   * The value written when the option is ADDED, so adding it is immediately
   * meaningful rather than an empty control the user must then fill.
   */
  addValue: unknown
  /**
   * n8n's `displayOptions`: an option that cannot apply to the node as
   * configured is not offered at all. Absent means always applicable.
   */
  appliesTo?: (node: FlowNode) => boolean
}

const SECONDS = (value: number) => value * 1000

function httpSendsBody(node: FlowNode): boolean {
  return node.type === 'http' && (node.data as { sendBody?: boolean }).sendBody === true
}

/** Options every executable step shares — the run-behaviour group. */
const RUN_BEHAVIOUR: NodeOption[] = [
  {
    key: 'onError',
    label: 'On error',
    description: 'What happens to the rest of the flow when this step fails.',
    control: {
      kind: 'select',
      choices: [
        { value: 'stop', label: 'Stop the flow' },
        { value: 'continue', label: 'Carry on to the next step' },
        { value: 'route', label: 'Follow the error path' },
      ],
    },
    addValue: 'continue',
  },
  {
    key: 'retries',
    label: 'Retries',
    description: 'How many times to try again before the step is treated as failed.',
    control: { kind: 'number', min: 0, max: 5, unit: 'count' },
    addValue: 2,
  },
  {
    key: 'retryDelayMs',
    label: 'Wait between tries',
    control: { kind: 'number', min: 0, max: 60, unit: 'seconds' },
    addValue: SECONDS(5),
  },
  {
    key: 'timeoutMs',
    label: 'Timeout',
    description: 'Give up on the step after this long.',
    control: { kind: 'number', min: 1, max: 120, unit: 'seconds' },
    addValue: SECONDS(30),
  },
  {
    key: 'alwaysOutputData',
    label: 'When there is no result',
    control: {
      kind: 'boolean',
      onLabel: 'Output an empty result so later steps still run',
      offLabel: 'Produce nothing, and skip what follows',
    },
    addValue: true,
  },
]

const HTTP_OPTIONS: NodeOption[] = [
  {
    key: 'responseType',
    label: 'Read the response as',
    control: {
      kind: 'select',
      choices: [
        { value: 'auto', label: 'Whatever it looks like' },
        { value: 'json', label: 'JSON' },
        { value: 'text', label: 'Text' },
        { value: 'file', label: 'A file to download' },
      ],
    },
    addValue: 'json',
  },
  {
    key: 'failOnHttpError',
    label: 'On a 4xx or 5xx response',
    control: {
      kind: 'boolean',
      onLabel: 'Treat it as a failure',
      offLabel: 'Carry on and hand back the response',
    },
    addValue: false,
  },
  {
    key: 'followRedirects',
    label: 'Follow redirects',
    description: 'Each hop is re-checked against the SSRF guard; credentials are dropped on cross-origin hops.',
    control: {
      kind: 'boolean',
      onLabel: 'Follow them',
      offLabel: 'Stop at the first redirect',
    },
    addValue: true,
  },
  {
    key: 'maxRedirects',
    // Only means anything once redirects are being followed at all.
    appliesTo: (node) => (node.data as { followRedirects?: boolean }).followRedirects === true,
    label: 'Redirects to follow',
    control: { kind: 'number', min: 0, max: 21, unit: 'count' },
    addValue: 5,
  },
  {
    key: 'bodyMode',
    label: 'Body format',
    // Only meaningful once the request actually sends one — n8n gates this the
    // same way, and offering it on a GET is offering a setting that does nothing.
    appliesTo: httpSendsBody,
    control: {
      kind: 'select',
      choices: [
        { value: 'json', label: 'JSON' },
        { value: 'text', label: 'Text' },
        { value: 'form-data', label: 'Form data' },
        { value: 'none', label: 'No body' },
      ],
    },
    addValue: 'json',
  },
  {
    key: 'pagination',
    label: 'Fetch every page',
    description: 'Follow the API’s paging until there is nothing left, and combine the results.',
    control: { kind: 'custom' },
    addValue: { mode: 'page', completeWhen: 'emptyPage' },
  },
  {
    key: 'optimizeForAi',
    label: 'Trim the response for AI',
    description: 'Keep only the part of a large response a later AI step needs.',
    control: { kind: 'custom' },
    addValue: {},
  },
]

const LOOP_OPTIONS: NodeOption[] = [
  {
    key: 'concurrency',
    label: 'How many at a time',
    control: { kind: 'number', min: 1, max: 20, unit: 'count' },
    addValue: 3,
  },
  {
    key: 'batchSize',
    label: 'Items per round',
    control: { kind: 'number', min: 1, max: 100, unit: 'count' },
    addValue: 10,
  },
]

const PER_ITEM_OPTION: NodeOption = {
  key: 'perItem',
  label: 'Run once per item',
  description: 'Repeat this step for every item in a list, instead of once for the whole list.',
  control: { kind: 'custom' },
  addValue: { source: '' },
}

const SUBFLOW_OPTION: NodeOption = {
  key: 'waitForCompletion',
  label: 'Wait for the other flow',
  control: {
    kind: 'boolean',
    onLabel: 'Wait, and use its result',
    offLabel: 'Start it and carry on',
  },
  addValue: false,
}

/**
 * Node types that support the per-item fan-out modifier (see perItemSchema).
 *
 * Moved here from the drawer when per-item became an option: the manifest is
 * now what decides whether the control is offered, and two lists of the same
 * nine types would drift the first time a tenth was added.
 */
export const PER_ITEM_TYPES: ReadonlySet<FlowNode['type']> = new Set([
  'agent', 'tool', 'http', 'ai', 'code', 'subflow', 'data', 'transform', 'knowledge',
])

const BY_TYPE: Partial<Record<FlowNode['type'], NodeOption[]>> = {
  http: [...HTTP_OPTIONS, ...RUN_BEHAVIOUR, PER_ITEM_OPTION],
  agent: [...RUN_BEHAVIOUR, PER_ITEM_OPTION],
  ai: [...RUN_BEHAVIOUR, PER_ITEM_OPTION],
  tool: [...RUN_BEHAVIOUR, PER_ITEM_OPTION],
  subflow: [...RUN_BEHAVIOUR, SUBFLOW_OPTION, PER_ITEM_OPTION],
  knowledge: [...RUN_BEHAVIOUR, PER_ITEM_OPTION],
  data: [PER_ITEM_OPTION],
  transform: [PER_ITEM_OPTION],
  // The code node stores neither alwaysOutputData nor retries, and the
  // interpreter never reads them — offering either would be a dead control.
  code: [RUN_BEHAVIOUR[0], RUN_BEHAVIOUR[3], PER_ITEM_OPTION],
  loop: LOOP_OPTIONS,
}

/** Every option this node type declares, applicable or not. */
export function nodeOptions(type: FlowNode['type']): readonly NodeOption[] {
  return BY_TYPE[type] ?? []
}

/**
 * The options that apply to this node AS CONFIGURED.
 *
 * n8n's `displayOptions`, and the reason its 86-parameter node reads short: an
 * option that cannot do anything — a body format on a request that sends no
 * body — is not offered, not greyed out.
 */
export function applicableOptions(node: FlowNode): readonly NodeOption[] {
  return nodeOptions(node.type).filter((option) => !option.appliesTo || option.appliesTo(node))
}

/** Is this option currently added to the node? */
export function isOptionAdded(node: FlowNode, key: string): boolean {
  return (node.data as Record<string, unknown>)[key] !== undefined
}

/** The added options, in manifest order so the panel never reshuffles. */
export function addedOptions(node: FlowNode): readonly NodeOption[] {
  return applicableOptions(node).filter((option) => isOptionAdded(node, option.key))
}

/**
 * What the "Add option" control offers: applicable, and not already added.
 *
 * An option that stopped applying while it held a value stays VISIBLE (it is in
 * `addedOptions` only if applicable)… which is exactly the case that would
 * silently strand a stored value. See `strandedOptions`.
 */
export function addableOptions(node: FlowNode): readonly NodeOption[] {
  return applicableOptions(node).filter((option) => !isOptionAdded(node, option.key))
}

/**
 * Options that hold a value but no longer apply.
 *
 * Turning off "send body" leaves `bodyMode` set on a request that no longer has
 * one. n8n hides the control and keeps the value, which means a setting is in
 * force that the panel does not show. Surfacing them lets the panel say so and
 * offer to clear them, rather than the value acting invisibly.
 */
export function strandedOptions(node: FlowNode): readonly NodeOption[] {
  const applicable = new Set(applicableOptions(node).map((option) => option.key))
  return nodeOptions(node.type).filter((option) => !applicable.has(option.key) && isOptionAdded(node, option.key))
}

/** Add an option at its default, or remove it, as a data patch. */
export function optionPatch(option: NodeOption, action: 'add' | 'remove'): Record<string, unknown> {
  return { [option.key]: action === 'add' ? option.addValue : undefined }
}
