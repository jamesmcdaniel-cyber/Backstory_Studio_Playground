/**
 * Redact credentials out of run data before it is written.
 *
 * Run history is the highest-value, least-protected store in a workflow
 * platform: it accumulates indefinitely, it is readable by everyone who can see
 * the run, and nobody thinks of it as a credential store. Before this, step
 * INPUTS got a headers-only redaction on http nodes and step OUTPUTS got none
 * at all — so any flow calling a token endpoint persisted the resulting
 * access_token in full, permanently.
 *
 * ── Why this lives in the Prisma extension ─────────────────────────────────
 *
 * Run data is written from roughly eight places in the executor (the running
 * insert, four success paths, the failure sweep, the waiting-state write, the
 * late adapter write). Redacting at each of them means the ninth one added next
 * quarter silently reopens the hole — the same failure that let `org-transfer`
 * hold the only working revocation logic while deactivation quietly skipped it.
 *
 * Putting it where every write already passes makes it structural: there is no
 * way to write a FlowRunStep output that has not been through the redactor.
 *
 * ── Why redact on WRITE rather than on read ────────────────────────────────
 *
 * A read-time filter leaves the plaintext in the database, so it is still in
 * every backup, every replica and every future query that forgets to apply it.
 * The value of a secret in run history is not that it is displayed — it is that
 * it is stored.
 */

import { redactFlowValue } from '@/lib/flows/secret-redaction'
import { findSecretCandidates } from '@/lib/catalogue/sanitize'

/** Models and fields whose contents are user/third-party data, not our own. */
const REDACTED_WRITE_FIELDS: Record<string, readonly string[]> = {
  // Step input carries the resolved node config; output carries whatever the
  // third party returned, under keys we do not control; logs carry whatever the
  // author printed.
  FlowRunStep: ['input', 'output', 'logs', 'warnings'],
  // The run's own trigger payload (an inbound webhook body may carry a token)
  // and its final output, which is usually the last step's.
  FlowRun: ['input', 'output', 'trigger'],
}

const WRITE_OPERATIONS = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'createManyAndReturn',
])

/** Reads the CURRENTLY PERSISTED `warnings` array for the row(s) a write's
 *  `where` clause targets. Supplied by the Prisma extension (via the
 *  unextended base client, so the read itself never recurses back through
 *  this guard) and invoked ONLY when a write needs to append the redaction
 *  marker but does not otherwise carry `warnings` in its own payload — the
 *  rare case, not the common one. Absent (e.g. plain unit tests calling this
 *  function directly), the guard skips the append rather than guess. */
export type WarningsReader = (where: unknown) => Promise<unknown>

/**
 * Rewrite a Prisma write so any run-data field is redacted.
 *
 * Returns `args` unchanged for every model and operation it does not govern,
 * so it costs one Set lookup on the overwhelming majority of queries.
 */
export async function applyRunDataRedaction(
  model: string | undefined,
  operation: string,
  args: unknown,
  readWarnings?: WarningsReader,
): Promise<unknown> {
  if (!model || !WRITE_OPERATIONS.has(operation)) return args
  const fields = REDACTED_WRITE_FIELDS[model]
  if (!fields) return args
  if (!args || typeof args !== 'object') return args

  const input = args as Record<string, unknown>
  let changed = false
  const next: Record<string, unknown> = { ...input }

  // update/updateMany write onto a row that may ALREADY carry warnings this
  // write never mentions — appending the marker there must read-then-append,
  // never blindly set. create/createMany/upsert's `create` branch always
  // insert a fresh row, so there is nothing prior to lose.
  const targetsExistingRow = operation === 'update' || operation === 'updateMany'
  const readerFor = (existingRow: boolean) =>
    existingRow && readWarnings ? () => readWarnings(input.where) : undefined

  // `data` is an object for create/update/updateMany and an array for
  // createMany/createManyAndReturn.
  if (input.data) {
    const redacted = await redactDataPayload(input.data, fields, model, targetsExistingRow, readerFor(targetsExistingRow))
    if (redacted !== input.data) {
      next.data = redacted
      changed = true
    }
  }

  // upsert carries two payloads: `create` never targets an existing row;
  // `update` does, sharing the same `where` as the statement itself.
  if (input.create) {
    const redacted = await redactDataPayload(input.create, fields, model, false)
    if (redacted !== input.create) {
      next.create = redacted
      changed = true
    }
  }
  if (input.update) {
    const redacted = await redactDataPayload(input.update, fields, model, true, readerFor(true))
    if (redacted !== input.update) {
      next.update = redacted
      changed = true
    }
  }

  return changed ? next : args
}

/** The literal warning appended to a FlowRunStep row when redaction actually
 *  changed its persisted bytes — so resume seeding (which replays a step's
 *  stored output as if it were the real one) surfaces that the value it is
 *  replaying is not what the step actually produced. */
export const REDACTED_AT_REST_WARNING = 'output redacted at rest'

/** Cheap deep-equality for values that only ever contain JSON — every field
 *  this guard touches is a Prisma Json column, so this is exact, not a
 *  heuristic. Used to tell "redaction rebuilt an identical object" (the
 *  redactor always allocates a fresh object/array) from "redaction actually
 *  removed a secret". */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

async function redactDataPayload(
  data: unknown,
  fields: readonly string[],
  model?: string,
  // True when `data` is being applied to a row that may already exist (and so
  // may already carry warnings this payload never mentions) — createMany's
  // array entries are always fresh inserts, so recursion always passes false.
  existingRow = false,
  getExistingWarnings?: () => Promise<unknown>,
): Promise<unknown> {
  if (Array.isArray(data)) {
    const mapped = await Promise.all(data.map((entry) => redactDataPayload(entry, fields, model, false)))
    return mapped.some((entry, index) => entry !== data[index]) ? mapped : data
  }
  if (!data || typeof data !== 'object') return data

  const record = data as Record<string, unknown>
  let changed = false
  // Whether input/output/logs (the fields resume seeding and the run panel
  // treat as "what actually happened") were changed by redaction — as
  // opposed to `warnings`, which is redacted too but must never count toward
  // this, or appending our own marker below would flag itself as content
  // that needs a marker appended.
  let contentRedacted = false
  const next: Record<string, unknown> = { ...record }

  for (const field of fields) {
    const value = record[field]
    // undefined means "not being written"; null is a real value but has nothing
    // to redact. Skipping both avoids turning a partial update into a full one.
    if (value === undefined || value === null) continue
    const redacted = redactFlowValue(value)
    // The redactor always allocates a fresh object, so only a byte-level
    // comparison tells a clean row (no warning earned) from a row that
    // actually lost a secret (warning earned) — the constraint this whole
    // change turns on.
    if (sameJson(redacted, value)) continue
    next[field] = redacted
    changed = true
    if (field !== 'warnings') contentRedacted = true
  }

  if (contentRedacted && model === 'FlowRunStep') {
    if (Array.isArray(next.warnings)) {
      // This write already fully specifies `warnings` (author-provided, or
      // just redacted above) — appending onto exactly that array is what the
      // write itself declares, so it is never lossy.
      next.warnings = [...(next.warnings as unknown[]), REDACTED_AT_REST_WARNING]
      changed = true
    } else if (!existingRow) {
      // A fresh insert (create/createMany/upsert's create branch): there is
      // no prior row, so nothing already-persisted can be lost.
      next.warnings = [REDACTED_AT_REST_WARNING]
      changed = true
    } else if (getExistingWarnings) {
      // update/updateMany that never mentions `warnings`: the row may
      // already carry one (e.g. an earlier item's degraded-success note on
      // the same aggregate row) — setting `[marker]` here would silently
      // discard it, breaking the additive-warnings invariant every other
      // write path in this file relies on. Read the row's CURRENT warnings
      // first so the append can never clobber them.
      const existing = await getExistingWarnings()
      next.warnings = [...(Array.isArray(existing) ? existing : []), REDACTED_AT_REST_WARNING]
      changed = true
    }
    // existingRow with no reader available (e.g. a bare unit-test call):
    // never guess — skip the append rather than risk a lossy overwrite.
  }

  return changed ? next : data
}


// ── Save-time secret scanning ──────────────────────────────────────────────

/** Graph fields whose contents are author-written and can hold a literal key. */
const SCANNED_GRAPH_FIELDS = ['graph', 'publishedGraph'] as const

/** Cap so one pathological graph cannot write a megabyte of findings. */
const MAX_STORED_FINDINGS = 25

/**
 * Annotate a Flow write with the literal credentials its graph appears to carry.
 *
 * The scanner (`findSecretCandidates`) already existed and is good — it strips
 * `{{refs}}` and scans the remainder, so a live key sitting beside a legitimate
 * reference is still caught. It just ran in exactly ONE place: catalogue
 * submission, as a warning to a reviewer. A hardcoded key in a step config was
 * therefore invisible unless someone happened to publish that flow publicly.
 *
 * Advisory, never blocking. Refusing the save reads as data loss to the author,
 * who works around it — usually by keeping the secret somewhere worse. A flow
 * that carries a literal credential instead says so on its own card until it is
 * fixed, which is the version people actually act on.
 *
 * Computed in the same write as the graph, so the findings can never describe a
 * version of the graph that is no longer stored.
 */
export function applyFlowSecretScan(
  model: string | undefined,
  operation: string,
  args: unknown,
): unknown {
  if (model !== 'Flow' || !WRITE_OPERATIONS.has(operation)) return args
  if (!args || typeof args !== 'object') return args

  const input = args as Record<string, unknown>
  let changed = false
  const next: Record<string, unknown> = { ...input }

  for (const key of ['data', 'create', 'update'] as const) {
    if (!input[key]) continue
    const scanned = scanPayload(input[key])
    if (scanned !== input[key]) {
      next[key] = scanned
      changed = true
    }
  }

  return changed ? next : args
}

function scanPayload(data: unknown): unknown {
  if (Array.isArray(data)) {
    const mapped = data.map(scanPayload)
    return mapped.some((entry, index) => entry !== data[index]) ? mapped : data
  }
  if (!data || typeof data !== 'object') return data

  const record = data as Record<string, unknown>
  const graphField = SCANNED_GRAPH_FIELDS.find((field) => record[field] !== undefined && record[field] !== null)
  if (!graphField) return data

  let findings: ReturnType<typeof findSecretCandidates>
  try {
    findings = findSecretCandidates(record[graphField], MAX_STORED_FINDINGS)
  } catch {
    // A scan failure must never fail the save. An unscannable graph is recorded
    // as unscanned rather than as clean — the UI tells those apart.
    return data
  }

  return {
    ...record,
    secretFindings: findings.length ? findings : [],
    secretScanAt: new Date(),
  }
}
