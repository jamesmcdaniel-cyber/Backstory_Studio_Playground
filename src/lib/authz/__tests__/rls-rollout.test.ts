import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rlsEnabledModels } from '../rls-rollout'
import { ORG_SCOPED_MODELS } from '@/lib/tenant-guard'

/**
 * The staged rollout is the mechanism that makes re-enabling RLS survivable
 * after the batch attempt caused three outages. Its failure modes are all
 * silent-by-default — a typo'd model name that protects nothing, an empty value
 * read as "on" — so each one is pinned here.
 */

const env = (value?: string) => ({ ...(value === undefined ? {} : { DATABASE_RLS_ENABLED: value }) }) as NodeJS.ProcessEnv

test('unset and false mean off', () => {
  assert.equal(rlsEnabledModels(env()).size, 0)
  assert.equal(rlsEnabledModels(env('false')).size, 0)
  assert.equal(rlsEnabledModels(env('')).size, 0)
  assert.equal(rlsEnabledModels(env('   ')).size, 0)
})

test("'true' means every org-scoped model", () => {
  const models = rlsEnabledModels(env('true'))
  assert.equal(models.size, ORG_SCOPED_MODELS.size)
  assert.ok(models.size > 0, 'ORG_SCOPED_MODELS should not be empty')
})

test('a model list enables exactly those models', () => {
  const [first, second] = [...ORG_SCOPED_MODELS]
  const models = rlsEnabledModels(env(`${first},${second}`))

  assert.equal(models.size, 2)
  assert.ok(models.has(first))
  assert.ok(models.has(second))
  // The staged rollout is only meaningful if the rest stay OFF.
  const untouched = [...ORG_SCOPED_MODELS].filter((m) => m !== first && m !== second)
  for (const model of untouched) assert.ok(!models.has(model), `${model} should not be enabled`)
})

test('whitespace around names is tolerated', () => {
  const [first] = [...ORG_SCOPED_MODELS]
  assert.ok(rlsEnabledModels(env(` ${first} , `)).has(first))
})

test('an unknown model name throws instead of silently protecting nothing', () => {
  const [first] = [...ORG_SCOPED_MODELS]
  assert.throws(
    () => rlsEnabledModels(env(`${first},FlowRuns`)),
    /unknown model\(s\): FlowRuns/,
  )
})

test('a table-name typo (snake_case) is rejected, not accepted as a no-op', () => {
  // The single most likely mistake: reaching for the Postgres table name.
  assert.throws(() => rlsEnabledModels(env('flow_runs')), /unknown model/)
})
