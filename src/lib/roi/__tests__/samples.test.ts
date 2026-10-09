import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { headerOf } from '../load-extract'
import { missingRequiredColumns, ROI_SOURCE_KINDS, type RoiSourceKind } from '../source-kinds'
import { runRoiPrep } from '../prep'
import { runAccount360Prep } from '../account360/prep'
import { templatesFor } from '../sources'
import type { CodeDataset } from '@/features/flows/code-runner'

/**
 * The sample extracts in docs/roi-sample-extracts are the contract made
 * concrete: synthetic, one file per kind, every required column present. The
 * prep that builds the report must read them as the extracts they are — so a
 * flow author who matches the samples gets a full report, not an empty section.
 */
const DIR = path.join(process.cwd(), 'docs', 'roi-sample-extracts')
const sample = (kind: RoiSourceKind): CodeDataset => ({ name: kind, filename: `${kind}.csv`, bytes: readFileSync(path.join(DIR, `${kind}.csv`)) })

test('there is a sample for every extract kind, and each satisfies its contract', () => {
  for (const kind of ROI_SOURCE_KINDS) {
    const header = headerOf(sample(kind).bytes.toString('utf8'))
    assert.ok(header.length >= 2, `${kind}.csv has a header`)
    assert.deepEqual(missingRequiredColumns(kind, header), [], `${kind}.csv has every required column`)
  }
  assert.deepEqual(templatesFor(Object.fromEntries(ROI_SOURCE_KINDS.map((kind) => [kind, true]))), ['standard', 'engagement', 'account360'])
})

test('the standard prep builds every section from the four rep-engagement samples', { timeout: 180_000 }, async () => {
  const facts = await runRoiPrep([sample('activity'), sample('usage'), sample('engagement'), sample('stages')])
  assert.ok(facts.U, 'activity section')
  assert.equal(facts.U!.months.length, 24)
  assert.equal(facts.U!.users.length, 12)
  assert.equal(facts.U!.hasUsage, true, 'adoption tiers from the usage sample')
  assert.ok(facts.OPP && Object.keys(facts.OPP).length > 0, 'deal engagement section')
  assert.ok(facts.ST && Object.keys(facts.ST).length > 0, 'stage section')
  const unavailable = (facts.notes ?? []).filter((note: string) => /unavailable|no activity extract|no usage cohort/i.test(note))
  assert.deepEqual(unavailable, [], 'nothing the samples feed is reported missing')
})

test('the Account 360 prep cohorts the accounts from the three samples', { timeout: 180_000 }, async () => {
  const facts = await runAccount360Prep([sample('clickstream'), sample('accounts'), sample('opportunities')])
  assert.ok(facts.BUNDLE.accounts.length > 0)
  assert.equal(facts.BUNDLE.cohorts_static.length, 5)
  assert.ok(facts.BUNDLE.cohorts_static.some((row) => row.cohort !== 'No Engagement' && row.n > 0), 'engaged cohorts are populated')
})
