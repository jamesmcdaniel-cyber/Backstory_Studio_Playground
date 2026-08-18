import type { OutputField } from '@/lib/flows/graph'
import { unwrapStepOutput } from '@/features/flows/context'

/** A node in the datatree field picker: a mappable value + its child fields. */
export type DataField = {
  label: string
  token: string
  type: string
  description?: string
  children?: DataField[]
}

function typeOf(value: unknown): string {
  if (value === undefined) return 'any'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * Infer the field tree from an actual value (e.g. a step's last-run output).
 * `basePath` is a dot-path without braces (e.g. "step.n1.output"). Bounded depth
 * so deeply-nested or recursive data can't explode the tree.
 */
export function inferFields(value: unknown, basePath: string, depth = 0): DataField[] {
  if (depth > 3 || value == null || typeof value !== 'object') return []
  if (Array.isArray(value)) {
    const sample = value[0]
    if (sample === undefined) return []
    return [
      {
        label: '[0]',
        token: `{{${basePath}.0}}`,
        type: typeOf(sample),
        description: 'First item in the list.',
        children: inferFields(sample, `${basePath}.0`, depth + 1),
      },
    ]
  }
  return Object.entries(value as Record<string, unknown>).map(([key, val]) => ({
    label: key,
    token: `{{${basePath}.${key}}}`,
    type: typeOf(val),
    description: `Field from ${basePath}.`,
    children: inferFields(val, `${basePath}.${key}`, depth + 1),
  }))
}

export type DataTreeSource = {
  /** Upstream steps available to map from, nearest last. */
  upstream: { id: string; label: string; outputFields?: OutputField[] }[]
  /** Include the trigger input root (default true). */
  trigger?: boolean
  /** User-declared fields expected on trigger.input. */
  inputFields?: (OutputField & { format?: string })[]
  /** Sample trigger input from test input or the latest run, used to expose fields. */
  triggerInput?: unknown
  /** Inside a loop body: expose {{item}} and {{loop.index}}. */
  insideLoop?: boolean
  /** Parsed last-run outputs keyed by node id — fields are inferred from them. */
  lastOutputs?: Record<string, unknown>
  /** Variables initialized by upstream variable steps, exposed as {{var.<name>}}. */
  variables?: { name: string; type: string }[]
  /** Include the run-context roots ({{now}} / {{run.*}}); default true. Off for
   *  the pre-run trigger gate, where run metadata isn't meaningful yet. */
  context?: boolean
}

/** The always-available run-context roots: the frozen clock and run metadata,
 *  set automatically for every run. */
function contextRoots(): DataField[] {
  return [
    {
      label: 'Now',
      token: '{{now}}',
      type: 'string',
      description: 'Set automatically for every run.',
      children: [
        { label: 'Date', token: '{{now.date}}', type: 'string', description: "Today's date, as YYYY-MM-DD." },
        { label: 'Time of day', token: '{{now.time}}', type: 'string', description: 'The current time of day, as HH:MM.' },
        { label: 'Timestamp', token: '{{now.unix}}', type: 'number', description: 'Seconds since the Unix epoch.' },
      ],
    },
    {
      label: 'This run',
      token: '{{run.id}}',
      type: 'string',
      description: 'Set automatically for every run.',
      children: [
        { label: 'Flow name', token: '{{flow.name}}', type: 'string', description: 'The name of this flow.' },
        { label: 'Trigger', token: '{{run.trigger}}', type: 'string', description: 'How this run was started.' },
        { label: 'Started at', token: '{{run.startedAt}}', type: 'string', description: 'When this run began.' },
        { label: 'Run link', token: '{{run.url}}', type: 'string', description: 'A link to this run in the builder.' },
        { label: 'Run resume link', token: '{{run.resumeUrl}}', type: 'string', description: 'The callback URL for a "wait for a callback" step.' },
      ],
    },
  ]
}

/** Build the datatree roots for the field picker. */
export function buildDataTree(source: DataTreeSource): DataField[] {
  const roots: DataField[] = []
  if (source.trigger !== false) {
    const children: DataField[] = []
    for (const field of source.inputFields ?? []) {
      if (!field.name.trim()) continue
      children.push({
        label: field.name,
        token: `{{trigger.input.${field.name}}}`,
        type: field.type,
        description: field.description || 'Expected field on the run input.',
        ...(field.format === 'file'
          ? {
              children: [
                { label: 'File name', token: `{{trigger.input.${field.name}.filename}}`, type: 'string', description: 'The uploaded file\'s name.' },
                { label: 'File text', token: `{{trigger.input.${field.name}.content}}`, type: 'string', description: 'The uploaded file\'s text content.' },
              ],
            }
          : {}),
      })
    }
    for (const inferred of inferFields(source.triggerInput, 'trigger.input')) {
      if (!children.some((child) => child.label === inferred.label)) children.push(inferred)
    }
    roots.push({
      label: 'Run input',
      token: '{{trigger.input}}',
      type: typeOf(source.triggerInput) === 'any' ? 'string' : typeOf(source.triggerInput),
      description: 'The text, JSON, or webhook payload passed when this flow starts.',
      children,
    })
  }
  // Upstream initialized variables, each a root of its own: every DataTree row
  // is insertable and there is no aggregate all-variables token to hang a
  // grouping root on.
  for (const variable of source.variables ?? []) {
    if (!variable.name.trim()) continue
    roots.push({
      label: `Variable ${variable.name}`,
      token: `{{var.${variable.name}}}`,
      type: variable.type,
      description: 'Variable set earlier in this flow.',
    })
  }
  if (source.insideLoop) {
    const item = source.lastOutputs?.__item
    roots.push({
      label: 'Current item',
      token: '{{item}}',
      type: typeOf(item),
      description: 'The single item this For each step is processing right now.',
      children: inferFields(item, 'item'),
    })
    roots.push({
      label: 'Item number',
      token: '{{loop.index}}',
      type: 'number',
      description: 'Zero-based position of the current item in the list.',
    })
  }
  // The "incoming data" root: whatever the previous step passes into this one,
  // resolved per branch at run time — so it keeps meaning the right thing when
  // steps are inserted or re-wired. Absent on the first step, where the
  // incoming data IS the run input and that root already exists above.
  if (source.upstream.length >= 1) {
    const direct = source.upstream[source.upstream.length - 1]
    const observed = unwrapStepOutput(source.lastOutputs?.[direct.id])
    roots.push({
      label: 'Incoming data',
      token: '{{input}}',
      type: observed === undefined ? 'any' : typeOf(observed),
      description: `What the previous step (${direct.label}) passes into this one — follows re-wiring automatically.`,
      children: inferFields(observed, 'input'),
    })
  }
  // Aggregate root: one chip that feeds EVERYTHING earlier steps captured
  // (each API/query node's data, labeled). Only worth offering when there are
  // ≥2 upstream steps — with one, its dedicated root below already covers it.
  if (source.upstream.length >= 2) {
    roots.push({
      label: 'All earlier data',
      token: '{{steps}}',
      type: 'object',
      description: 'Everything captured by the steps before this one, combined into one value.',
    })
  }
  for (const step of source.upstream) {
    const basePath = `step.${step.id}.output`
    const children: DataField[] = []
    for (const field of step.outputFields ?? []) {
      children.push({
        label: field.name,
        token: `{{${basePath}.${field.name}}}`,
        type: field.type,
        description: `Declared output field from ${step.label}.`,
      })
    }
    const observed = source.lastOutputs?.[step.id]
    if (observed && typeof observed === 'object') {
      for (const inferred of inferFields(observed, basePath)) {
        if (!children.some((c) => c.label === inferred.label)) children.push(inferred)
      }
    }
    roots.push({
      label: step.label,
      token: `{{${basePath}}}`,
      type: 'object',
      description: `Full output from ${step.label}.`,
      children: children.length ? children : undefined,
    })
  }
  if (source.context !== false) roots.push(...contextRoots())
  return roots
}

/**
 * The subset of the datatree a user can bind to a multipart FILE field, as
 * pickable options: a file arrives as an object (a file reference), so scalar
 * leaves and the always-present run-context roots are dropped. `path` is the
 * bare context path stored on the step — the picker shows `label`, so no token
 * syntax ever reaches the UI.
 */
export function fileBindingOptions(fields: DataField[]): { label: string; path: string }[] {
  const options: { label: string; path: string }[] = []
  const skipRoots = /^\{\{(now|run|flow|loop)[.}]/
  const walk = (field: DataField, trail: string[], depth: number) => {
    if (depth > 2) return
    const label = [...trail, field.label].join(' › ')
    if (field.type === 'object' || field.type === 'array' || field.type === 'any' || field.type === 'file') {
      options.push({ label, path: field.token.replace(/^\{\{\s*|\s*\}\}$/g, '') })
    }
    for (const child of field.children ?? []) walk(child, [...trail, field.label], depth + 1)
  }
  for (const field of fields) {
    if (skipRoots.test(field.token)) continue
    walk(field, [], 0)
  }
  // Dedupe by path, keeping the first (shallowest) label for each.
  const seen = new Set<string>()
  return options.filter((option) => (seen.has(option.path) ? false : (seen.add(option.path), true)))
}
