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

/**
 * Rewrite a Prisma write so any run-data field is redacted.
 *
 * Returns `args` unchanged for every model and operation it does not govern,
 * so it costs one Set lookup on the overwhelming majority of queries.
 */
export function applyRunDataRedaction(
  model: string | undefined,
  operation: string,
  args: unknown,
): unknown {
  if (!model || !WRITE_OPERATIONS.has(operation)) return args
  const fields = REDACTED_WRITE_FIELDS[model]
  if (!fields) return args
  if (!args || typeof args !== 'object') return args

  const input = args as Record<string, unknown>
  let changed = false
  const next: Record<string, unknown> = { ...input }

  // `data` is an object for create/update and an array for createMany.
  if (input.data) {
    const redacted = redactDataPayload(input.data, fields)
    if (redacted !== input.data) {
      next.data = redacted
      changed = true
    }
  }

  // upsert carries two payloads and both write run data.
  for (const key of ['create', 'update'] as const) {
    if (input[key]) {
      const redacted = redactDataPayload(input[key], fields)
      if (redacted !== input[key]) {
        next[key] = redacted
        changed = true
      }
    }
  }

  return changed ? next : args
}

function redactDataPayload(data: unknown, fields: readonly string[]): unknown {
  if (Array.isArray(data)) {
    const mapped = data.map((entry) => redactDataPayload(entry, fields))
    return mapped.some((entry, index) => entry !== data[index]) ? mapped : data
  }
  if (!data || typeof data !== 'object') return data

  const record = data as Record<string, unknown>
  let changed = false
  const next: Record<string, unknown> = { ...record }

  for (const field of fields) {
    const value = record[field]
    // undefined means "not being written"; null is a real value but has nothing
    // to redact. Skipping both avoids turning a partial update into a full one.
    if (value === undefined || value === null) continue
    const redacted = redactFlowValue(value)
    next[field] = redacted
    changed = true
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
