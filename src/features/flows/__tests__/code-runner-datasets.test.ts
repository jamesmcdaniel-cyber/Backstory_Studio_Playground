import test from 'node:test'
import assert from 'node:assert/strict'
import { runFlowCode, DATASET_TIMEOUT_MAX_MS } from '../code-runner'

// Dataset mode: tabular files land in the sandbox's virtual filesystem and
// arrive in the code as pandas DataFrames — no row marshalling through JS,
// pandas group-bys instead of hand-rolled loops. Kept separate from the base
// runner tests because loading pandas is the slow part of the suite.

const activity = Buffer.from(
  'email,months,meeting_count,pipeline_created\n' +
  'a@x.com,2026-01-01,4,1000\n' +
  'a@x.com,2026-02-01,6,3000\n' +
  'b@x.com,2026-01-01,2,\n' +
  'b@x.com,2026-02-01,8,500\n',
)

test('exposes datasets as DataFrames under input["frames"]', async () => {
  const { output } = await runFlowCode({
    language: 'python',
    mode: 'all',
    analysis: true,
    datasets: [{ name: 'activity', filename: 'Raw Data Extract.csv', bytes: activity }],
    code: [
      'df = input["frames"]["activity"]',
      'per_user = df.groupby("email")["meeting_count"].mean()',
      'return {"rows": len(df), "columns": list(df.columns), "avg": per_user.to_dict(), "total_pipeline": float(df["pipeline_created"].sum())}',
    ].join('\n'),
    input: null,
    timeoutMs: 120_000,
  })
  assert.deepEqual(output, {
    rows: 4,
    columns: ['email', 'months', 'meeting_count', 'pipeline_created'],
    avg: { 'a@x.com': 5, 'b@x.com': 5 },
    total_pipeline: 4500,
  })
})

test('serializes numpy scalars, NaN and timestamps that pandas produces', async () => {
  const { output } = await runFlowCode({
    language: 'python',
    mode: 'all',
    analysis: true,
    datasets: [{ name: 'activity', filename: 'activity.csv', bytes: activity }],
    code: [
      'df = input["frames"]["activity"]',
      'df["month"] = pd.to_datetime(df["months"])',
      'return {"max_meetings": df["meeting_count"].max(), "missing": df["pipeline_created"].iloc[2], "first_month": df["month"].min(), "records": records(df.head(1))}',
    ].join('\n'),
    input: null,
    timeoutMs: 120_000,
  })
  const value = output as Record<string, unknown>
  assert.equal(value.max_meetings, 8)
  assert.equal(value.missing, null)
  assert.equal(String(value.first_month).slice(0, 10), '2026-01-01')
  assert.deepEqual(value.records, [{ email: 'a@x.com', months: '2026-01-01', meeting_count: 4, pipeline_created: 1000, month: '2026-01-01T00:00:00' }])
})

test('dataset mode still refuses imports and keeps the file out of the next run', async () => {
  await assert.rejects(
    runFlowCode({
      language: 'python',
      mode: 'all',
      analysis: true,
      datasets: [{ name: 'activity', filename: 'activity.csv', bytes: activity }],
      code: 'import os\nreturn 1',
      input: null,
      timeoutMs: 120_000,
    }),
    /Imports/,
  )
  // A later plain run cannot see the dataset that was mounted before.
  await assert.rejects(
    runFlowCode({
      language: 'python',
      mode: 'all',
      analysis: true,
      code: 'return input["frames"]',
      input: {},
    }),
    /frames/,
  )
})

test('dataset mode allows a longer deadline than plain code', () => {
  assert.ok(DATASET_TIMEOUT_MAX_MS >= 300_000)
})
