import test from 'node:test'
import assert from 'node:assert/strict'
import { profileDataset, datasetProfileText } from '../dataset'

const csv = Buffer.from(
  'email,months,meeting_count,pipeline_created,is_won,"team, name"\n' +
  'a@x.com,2026-01-01 00:00:00,4,1000.5,TRUE,East\n' +
  'a@x.com,2026-02-01 00:00:00,6,,FALSE,East\n' +
  'b@x.com,2026-01-01 00:00:00,2,300,TRUE,"West, Coast"\n' +
  'b@x.com,2026-03-01 00:00:00,8,500,TRUE,West\n',
)

test('profiles columns, types, ranges and row count', () => {
  const profile = profileDataset(csv, 'Raw Data Extract.csv')
  assert.equal(profile.rowCount, 4)
  assert.equal(profile.delimiter, ',')
  assert.deepEqual(profile.columns.map((c) => c.name), ['email', 'months', 'meeting_count', 'pipeline_created', 'is_won', 'team, name'])
  const byName = Object.fromEntries(profile.columns.map((c) => [c.name, c]))
  assert.equal(byName.email.type, 'text')
  assert.equal(byName.months.type, 'date')
  assert.equal(byName.months.min, '2026-01-01')
  assert.equal(byName.months.max, '2026-03-01')
  assert.equal(byName.meeting_count.type, 'number')
  assert.equal(byName.meeting_count.min, 2)
  assert.equal(byName.meeting_count.max, 8)
  assert.equal(byName.pipeline_created.type, 'number')
  assert.equal(byName.pipeline_created.empty, 1)
  assert.equal(byName.is_won.type, 'boolean')
  assert.deepEqual(byName.email.values, ['a@x.com', 'b@x.com'])
  assert.equal(profile.sample.length, 4)
  assert.equal(profile.sample[2]['team, name'], 'West, Coast')
})

test('counts rows without materialising every record', () => {
  const rows = Array.from({ length: 20_000 }, (_, i) => `u${i % 50}@x.com,2026-01-01,${i},${i * 2}`)
  const big = Buffer.from('email,months,a,b\n' + rows.join('\n') + '\n')
  const profile = profileDataset(big, 'big.csv')
  assert.equal(profile.rowCount, 20_000)
  assert.ok(profile.sample.length <= 10)
  const a = profile.columns.find((c) => c.name === 'a')!
  // Ranges come from the sampled head, and say so.
  assert.equal(profile.sampledRows, 5_000)
  assert.equal(a.min, 0)
})

test('renders a profile the repository can index and an agent can read', () => {
  const text = datasetProfileText(profileDataset(csv, 'Raw Data Extract.csv'))
  assert.match(text, /Dataset: Raw Data Extract\.csv/)
  assert.match(text, /4 rows/)
  assert.match(text, /months \(date, 2026-01-01 – 2026-03-01\)/)
  assert.match(text, /meeting_count \(number, 2 – 8\)/)
  assert.match(text, /pipeline_created \(number, 300 – 1000\.5, 1 empty\)/)
  assert.match(text, /is_won \(boolean\)/)
  assert.match(text, /email \(text\): a@x\.com, b@x\.com/)
})
