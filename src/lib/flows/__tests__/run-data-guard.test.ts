import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyRunDataRedaction, REDACTED_AT_REST_WARNING } from '../run-data-guard'
import { REDACTED } from '@/lib/logging/redact'

/**
 * This sits in the Prisma extension precisely so it cannot be bypassed by a new
 * executor write path. The tests therefore pin the SHAPES of Prisma write args
 * rather than any particular call site — create, update, updateMany, upsert and
 * createMany all reach the database, and one of them being missed is the whole
 * failure mode this replaces.
 */

const TOKEN_BODY = {
  access_token: `ya29.${'A'.repeat(28)}`,
  expires_in: 3600,
}

test('step output is redacted on create', async () => {
  const out = (await applyRunDataRedaction('FlowRunStep', 'create', {
    data: { id: 'step-1', output: { body: TOKEN_BODY } },
  })) as { data: { id: string; output: { body: Record<string, unknown> } } }

  assert.equal(out.data.output.body.access_token, REDACTED)
  assert.equal(out.data.output.body.expires_in, 3600, 'non-secret fields survive')
  assert.equal(out.data.id, 'step-1', 'unrelated fields are untouched')
})

test('step output is redacted on update — the path the executor actually uses most', async () => {
  const out = (await applyRunDataRedaction('FlowRunStep', 'update', {
    where: { id: 'step-1' },
    data: { status: 'succeeded', output: { body: TOKEN_BODY } },
  })) as { where: unknown; data: { status: string; output: { body: Record<string, unknown> } } }

  assert.equal(out.data.output.body.access_token, REDACTED)
  assert.equal(out.data.status, 'succeeded')
})

test('updateMany is covered — the executor finishes steps with it', async () => {
  const out = (await applyRunDataRedaction('FlowRunStep', 'updateMany', {
    where: { id: 'step-1', status: 'running' },
    data: { output: { token: ['sk', 'ant', 'api03', 'A'.repeat(24)].join('-') } },
  })) as { data: { output: Record<string, unknown> } }

  assert.equal(out.data.output.token, REDACTED)
})

test('upsert redacts BOTH payloads', async () => {
  // A create-side leak is just as permanent as an update-side one, and it is
  // the half that is easy to forget.
  const out = (await applyRunDataRedaction('FlowRunStep', 'upsert', {
    where: { id: 'step-1' },
    create: { output: { apiKey: 'literal-secret-value' } },
    update: { output: { apiKey: 'literal-secret-value' } },
  })) as { create: { output: Record<string, unknown> }; update: { output: Record<string, unknown> } }

  assert.equal(out.create.output.apiKey, REDACTED)
  assert.equal(out.update.output.apiKey, REDACTED)
})

test('createMany redacts every row in the array', async () => {
  const out = (await applyRunDataRedaction('FlowRunStep', 'createMany', {
    data: [
      { output: { password: 'one' } },
      { output: { password: 'two' } },
    ],
  })) as { data: Array<{ output: Record<string, unknown> }> }

  assert.equal(out.data[0].output.password, REDACTED)
  assert.equal(out.data[1].output.password, REDACTED)
})

test('code-step logs are redacted — console.log of a token is a real leak path', async () => {
  const out = (await applyRunDataRedaction('FlowRunStep', 'update', {
    data: { logs: [`fetched with Bearer ${['sk', 'ant', 'api03', 'B'.repeat(24)].join('-')}`] },
  })) as { data: { logs: string[] } }

  assert.ok(!out.data.logs[0].includes('api03-BBB'))
  assert.ok(out.data.logs[0].includes('fetched with'), 'the log stays useful')
})

test('the run trigger payload is redacted — an inbound webhook body may carry a token', async () => {
  const out = (await applyRunDataRedaction('FlowRun', 'create', {
    data: { trigger: { type: 'webhook', headers: { authorization: 'Bearer abcdefghijklmnop' } } },
  })) as { data: { trigger: { type: string; headers: Record<string, unknown> } } }

  assert.equal(out.data.trigger.headers.authorization, REDACTED)
  assert.equal(out.data.trigger.type, 'webhook')
})

// ── Not doing more than it should ──────────────────────────────────────────

test('reads are untouched', async () => {
  // Redacting a where clause would silently change which rows match.
  const args = { where: { output: { equals: 'anything' } } }
  assert.equal(await applyRunDataRedaction('FlowRunStep', 'findMany', args), args)
})

test('models outside the run-data set are untouched', async () => {
  const args = { data: { output: { apiKey: 'literal' } } }
  assert.equal(await applyRunDataRedaction('Flow', 'update', args), args)
  assert.equal(await applyRunDataRedaction('AgentExecution', 'create', args), args)
})

test('a write that touches no run-data field returns the SAME object', async () => {
  // Identity, not deep equality: a partial update must not be widened into a
  // full one, and allocating a copy on every write would be wasteful.
  const args = { where: { id: 'step-1' }, data: { status: 'running' } }
  assert.equal(await applyRunDataRedaction('FlowRunStep', 'update', args), args)
})

test('null and undefined run-data fields are left alone', async () => {
  // undefined means "not being written". Replacing it would turn a partial
  // update into one that nulls a column it never meant to touch.
  const args = { data: { status: 'failed', output: undefined } }
  const out = (await applyRunDataRedaction('FlowRunStep', 'update', args)) as { data: Record<string, unknown> }
  assert.equal('output' in out.data && out.data.output === undefined, true)
})

test('an unknown model with no args does not throw', async () => {
  await assert.doesNotReject(() => applyRunDataRedaction(undefined, 'update', undefined))
  await assert.doesNotReject(() => applyRunDataRedaction('FlowRunStep', 'update', null))
})

// ── Redaction provenance: the persisted trace must say when it lied ────────
//
// Before this, a step whose output got redacted looked IDENTICAL to a step
// that ran clean — resume seeding then replayed the redacted stand-in as if
// it were the real value, with nothing on the row saying otherwise.

test('a row whose output is actually redacted gets the "redacted at rest" warning appended', async () => {
  const out = (await applyRunDataRedaction('FlowRunStep', 'create', {
    data: { id: 'step-1', status: 'succeeded', output: { body: TOKEN_BODY } },
  })) as { data: { warnings: string[] } }

  assert.ok(out.data.warnings.includes(REDACTED_AT_REST_WARNING))
  assert.equal(out.data.warnings.length, 1)
})

test('the warning is appended AFTER any existing warnings on the row, never replacing them', async () => {
  const out = (await applyRunDataRedaction('FlowRunStep', 'create', {
    data: { id: 'step-1', output: { body: TOKEN_BODY }, warnings: ['retried once'] },
  })) as { data: { warnings: string[] } }

  assert.deepEqual(out.data.warnings, ['retried once', REDACTED_AT_REST_WARNING])
})

test('a clean row is returned completely untouched — same object, no warnings field added', async () => {
  // A field being PRESENT is not enough to earn the warning: only a value that
  // genuinely changed under redaction should. The redactor allocates a fresh
  // object either way, so a naive "field was written" check would false-fire
  // on every single row.
  const args = { data: { id: 'step-1', status: 'succeeded', output: { body: { total: 3, items: ['a', 'b'] } } } }
  const out = await applyRunDataRedaction('FlowRunStep', 'create', args)
  assert.equal(out, args, 'identity: nothing in this row needed redaction, so nothing was rewritten')
})

test('input, output AND logs redaction each independently earn the warning, but only one copy is appended', async () => {
  const out = (await applyRunDataRedaction('FlowRunStep', 'create', {
    data: {
      input: { token: TOKEN_BODY.access_token },
      output: { token: TOKEN_BODY.access_token },
      logs: [`Bearer ${TOKEN_BODY.access_token}`],
    },
  })) as { data: { warnings: string[] } }

  assert.deepEqual(out.data.warnings, [REDACTED_AT_REST_WARNING])
})

test('redacting the warnings FIELD itself never earns the marker — no self-recursion', async () => {
  // `warnings` is itself in REDACTED_WRITE_FIELDS (an author-authored warning
  // string could in principle carry a literal secret). If a warnings-field
  // redaction counted toward "content redacted", appending our own marker
  // string would immediately re-trigger itself in a future write of the same
  // row — the exact recursive loop the guard must never produce.
  const out = (await applyRunDataRedaction('FlowRunStep', 'update', {
    data: { warnings: [`leaked ${TOKEN_BODY.access_token}`] },
  })) as { data: { warnings: string[] } }

  assert.ok(!out.data.warnings.some((w) => w.includes(TOKEN_BODY.access_token)), 'the secret in the warning text is still redacted')
  assert.ok(!out.data.warnings.includes(REDACTED_AT_REST_WARNING), 'but redacting warnings alone never earns the "redacted at rest" marker')
})

test('the warning is never appended for FlowRun rows — only FlowRunStep carries a warnings column consumers read this way', async () => {
  const out = (await applyRunDataRedaction('FlowRun', 'create', {
    data: { trigger: { type: 'webhook', headers: { authorization: 'Bearer abcdefghijklmnop' } } },
  })) as { data: Record<string, unknown> }

  assert.equal('warnings' in out.data, false)
})

test('createMany: only the rows that actually lost a secret get the warning, not their neighbors', async () => {
  const out = (await applyRunDataRedaction('FlowRunStep', 'createMany', {
    data: [
      { output: { password: 'one' } },
      { output: { total: 3 } },
    ],
  })) as { data: Array<{ warnings?: string[]; output: Record<string, unknown> }> }

  assert.deepEqual(out.data[0].warnings, [REDACTED_AT_REST_WARNING])
  assert.equal(out.data[1].warnings, undefined)
})

// ── An update that never mentions `warnings` must never clobber what's
//    already persisted (code review finding) ────────────────────────────────
//
// The per-item aggregate updateMany in execute-flow.ts writes
// `{ output, ...warningsPatch }` with an EMPTY warningsPatch for an item that
// carries no warnings of its own. If an earlier item already left a
// legitimate warning on that same aggregate row, and THIS item's output
// happens to trigger redaction, a naive fix would overwrite the column with
// just `[REDACTED_AT_REST_WARNING]` — discarding real, unrelated evidence.
// This violates the file's own "undefined means not being written" rule.

test('update without `warnings` in its data: the row\'s CURRENT warnings survive alongside the marker', async () => {
  // Simulates the reader the Prisma extension supplies in prisma.ts — reading
  // the row's persisted warnings via the same `where` clause the write uses.
  const reader = async (where: unknown) => {
    assert.deepEqual(where, { id: 'step-1' })
    return ['an earlier item was dropped by the itemError policy']
  }

  const out = (await applyRunDataRedaction(
    'FlowRunStep',
    'update',
    { where: { id: 'step-1' }, data: { output: { body: TOKEN_BODY } } },
    reader,
  )) as { data: { warnings: string[] } }

  assert.deepEqual(out.data.warnings, ['an earlier item was dropped by the itemError policy', REDACTED_AT_REST_WARNING])
})

test('updateMany without `warnings` in its data: the same read-and-append applies', async () => {
  const reader = async () => ['prior degraded note']
  const out = (await applyRunDataRedaction(
    'FlowRunStep',
    'updateMany',
    { where: { flowRunId: 'run-1', nodeId: 'agg', status: 'succeeded' }, data: { output: { token: TOKEN_BODY.access_token } } },
    reader,
  )) as { data: { warnings: string[] } }

  assert.deepEqual(out.data.warnings, ['prior degraded note', REDACTED_AT_REST_WARNING])
})

test('update without `warnings` and WITHOUT a reader: never guess — skip the append rather than clobber', async () => {
  // No reader supplied (e.g. a caller that never wired one up). The guard must
  // not fabricate `[REDACTED_AT_REST_WARNING]` here — that would be exactly
  // the lossy overwrite this whole fix exists to prevent. It redacts the
  // content and leaves `warnings` alone entirely.
  const out = (await applyRunDataRedaction('FlowRunStep', 'update', {
    where: { id: 'step-1' },
    data: { output: { body: TOKEN_BODY } },
  })) as { data: Record<string, unknown> }

  assert.equal(out.data.output && (out.data.output as { body: { access_token: string } }).body.access_token, REDACTED)
  assert.equal('warnings' in out.data, false, 'no marker fabricated without a way to read what is already persisted')
})

test('a fresh insert never needs a reader — nothing prior exists to lose', async () => {
  // create/createMany/upsert-create pass existingRow=false regardless of
  // whether a reader was supplied, so the marker is set directly.
  const out = (await applyRunDataRedaction('FlowRunStep', 'create', {
    data: { output: { body: TOKEN_BODY } },
  })) as { data: { warnings: string[] } }

  assert.deepEqual(out.data.warnings, [REDACTED_AT_REST_WARNING])
})

test('item packets are redacted — the `json` in them is third-party output', async () => {
  // `items` was added as a persisted column carrying {json, binary, pairedItem}
  // where `json` is whatever a tool returned, under keys we do not control.
  // Same class of content as `output`, arriving by the same route.
  const out = (await applyRunDataRedaction('FlowRunStep', 'create', {
    data: {
      id: 'step-1',
      items: [
        { json: { account: 'Acme', ...TOKEN_BODY }, pairedItem: 0 },
        { json: { account: 'Beta' }, pairedItem: 1 },
      ],
    },
  })) as { data: { items: Array<{ json: Record<string, unknown> }>; warnings?: unknown[] } }

  assert.equal(out.data.items[0].json.access_token, REDACTED)
  assert.equal(out.data.items[0].json.account, 'Acme', 'the rest of the item survives')
  assert.equal(out.data.items[1].json.account, 'Beta', 'clean items are untouched')
  // Losing content to redaction earns the at-rest marker, exactly as output does.
  assert.deepEqual(out.data.warnings, [REDACTED_AT_REST_WARNING])
})

test('a clean item set earns no warning and is left byte-identical', async () => {
  const items = [{ json: { account: 'Acme' }, pairedItem: 0 }]
  const out = (await applyRunDataRedaction('FlowRunStep', 'create', {
    data: { id: 'step-1', items },
  })) as { data: { items: unknown; warnings?: unknown[] } }

  assert.equal(out.data.warnings, undefined, 'no secret lost, no marker')
  assert.deepEqual(out.data.items, items)
})
