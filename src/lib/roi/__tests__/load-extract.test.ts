import test from 'node:test'
import assert from 'node:assert/strict'
import { headerOf, loadRoiExtract, objectsToCsv, RoiExtractLoadError } from '../load-extract'
import { missingRequiredColumns, ROI_EXTRACT_CONTRACT, ROI_SOURCE_KINDS } from '../source-kinds'
import { ROI_TOOLS } from '../tools'
import { __setSsrfResolver, clearPins } from '@/lib/net/ssrf'

/**
 * The generic extract loader: any flow lands an account's extract in the
 * Repository with the ROI tag, from a link, a stored file, text or rows, and
 * learns at load time which required columns the file lacks.
 */

type Loaded = { account: string; kind: string; filename: string; buffer: Buffer; trusted?: boolean }

function fakeLoad() {
  const calls: Loaded[] = []
  const load = async (params: Loaded) => {
    calls.push(params)
    return { documentId: `doc-${calls.length}`, rows: null }
  }
  return { calls, load: load as unknown as NonNullable<Parameters<typeof loadRoiExtract>[0]['load']> }
}

const base = { organizationId: 'org', userId: 'user', account: ' Iron Mountain ', kind: 'activity', credentialFor: async () => null }

test('headers parse with quotes, tabs and a BOM; rows become CSV with the union of keys', () => {
  assert.deepEqual(headerOf('﻿email,"meeting, count",months\n'), ['email', 'meeting, count', 'months'])
  assert.deepEqual(headerOf('email\tmonths\tmeeting_count\nrow'), ['email', 'months', 'meeting_count'])
  assert.equal(objectsToCsv([{ email: 'a@x.com', months: '2026-01' }, { email: 'b@x.com', meeting_count: 3 }]), 'email,months,meeting_count\na@x.com,2026-01,\nb@x.com,,3\n')
  assert.throws(() => objectsToCsv([]), RoiExtractLoadError)
  assert.throws(() => objectsToCsv([1]), RoiExtractLoadError)
})

test('every kind has a contract, and the contract reads headers the way the prep does', () => {
  for (const kind of ROI_SOURCE_KINDS) assert.ok(ROI_EXTRACT_CONTRACT[kind].required.length && ROI_EXTRACT_CONTRACT[kind].feeds)
  assert.deepEqual(missingRequiredColumns('activity', ['email', 'months', 'meeting_count', 'x']), [])
  assert.deepEqual(missingRequiredColumns('activity', ['Email', 'months']), ['meeting_count'])
  // Descriptions with alternatives match any alternative, as a substring.
  assert.deepEqual(missingRequiredColumns('engagement', ['crm_id', 'won', 'avg_engagement']), [])
  assert.equal(missingRequiredColumns('engagement', ['crm_id', 'won']).length, 1)
  assert.deepEqual(missingRequiredColumns('clickstream', ['user_email', 'session_id', 'event_time', 'event_type', 'account_name']), [])
  assert.deepEqual(missingRequiredColumns('opportunities', ['created_date', 'close_date', 'stage', 'amount']), [])
})

test('CSV text and rows load tagged for the trimmed account, trusted, with the header and missing columns reported', async () => {
  const { calls, load } = fakeLoad()
  const result = await loadRoiExtract({ ...base, csv: 'email,months\na@x.com,2026-01\n"b@x.com","2026-02"\n', load })
  assert.equal(result.documentId, 'doc-1')
  assert.equal(result.account, 'Iron Mountain')
  assert.equal(result.rows, 2)
  assert.deepEqual(result.columns, ['email', 'months'])
  assert.deepEqual(result.missingColumns, ['meeting_count'])
  assert.equal(result.source, 'csv')
  assert.equal(calls[0].filename, 'Iron_Mountain_activity.csv')
  assert.equal(calls[0].trusted, true)

  const fromRows = await loadRoiExtract({ ...base, kind: 'usage', rows: [{ email: 'a@x.com', EDB_views: 4 }], filename: 'usage', load })
  assert.equal(fromRows.source, 'rows')
  assert.equal(calls[1].filename, 'usage.csv')
  assert.deepEqual(fromRows.missingColumns, [])
})

test('a stored file loads under its own name; a link is fetched on the platform and its size bounded', async (t) => {
  // The SSRF guard resolves the host before dialling: answer with a public address.
  __setSsrfResolver(async () => [{ address: '93.184.216.34', family: 4 }])
  clearPins()
  t.after(() => { __setSsrfResolver(null); clearPins() })
  const { calls, load } = fakeLoad()
  const stored = await loadRoiExtract({ ...base, storedFileId: 'sf1', load, readStored: async () => ({ filename: 'Raw.csv', mimeType: 'text/csv', buffer: Buffer.from('email,months,meeting_count\na,b,c\n') }) })
  assert.equal(stored.source, 'storedFile')
  assert.equal(calls[0].filename, 'Raw.csv')
  await assert.rejects(loadRoiExtract({ ...base, storedFileId: 'nope', load, readStored: async () => null }), /No ready file/)

  const fetchImpl = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), 'https://files.example.com/export/activity.csv')
    return new Response('email,months,meeting_count\na,b,1\n', { status: 200, headers: { 'content-type': 'text/csv' } })
  }) as typeof fetch
  const fetched = await loadRoiExtract({ ...base, url: 'https://files.example.com/export/activity.csv', load, fetchImpl })
  assert.equal(fetched.source, 'url')
  assert.equal(calls[1].filename, 'activity.csv')
  const failing = (async () => new Response('nope', { status: 403 })) as typeof fetch
  await assert.rejects(loadRoiExtract({ ...base, url: 'https://files.example.com/x.csv', load, fetchImpl: failing }), /HTTP 403/)
  const html = (async () => new Response('<html><body>sign in</body></html>', { status: 200 })) as typeof fetch
  await assert.rejects(loadRoiExtract({ ...base, url: 'https://files.example.com/x.csv', load, fetchImpl: html }), /not a CSV or TSV/)
})

test('it refuses a blank account, an unknown kind, two sources at once, an empty file and a one-column file', async () => {
  const { load } = fakeLoad()
  await assert.rejects(loadRoiExtract({ ...base, account: ' ', csv: 'a,b\n1,2\n', load }), /Pass the account/)
  await assert.rejects(loadRoiExtract({ ...base, kind: 'bookings', csv: 'a,b\n1,2\n', load }), /not an extract kind/)
  await assert.rejects(loadRoiExtract({ ...base, csv: 'a,b\n1,2\n', rows: [{ a: 1 }], load }), /exactly one of/)
  await assert.rejects(loadRoiExtract({ ...base, load }), /exactly one of/)
  await assert.rejects(loadRoiExtract({ ...base, csv: 'email,months\n', load }), /no rows/)
  await assert.rejects(loadRoiExtract({ ...base, csv: 'email\na\n', load }), /fewer than two columns/)
})

test('the tool is a write on the ROI plane that takes the account, the kind and one source', () => {
  const tool = ROI_TOOLS.find((entry) => entry.name === 'roi_load_extract')
  assert.ok(tool && tool.isWrite)
  assert.deepEqual(tool.inputSchema.required, ['account', 'kind'])
  for (const key of ['url', 'storedFileId', 'csv', 'rows']) assert.ok(key in tool.inputSchema.properties, `${key} is an input`)
  assert.ok(!tool.description.includes('{{'), 'no raw token syntax where a person reads')
})
