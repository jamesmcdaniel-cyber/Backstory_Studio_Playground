import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolveExecutionMode } from '../execution-mode'

const ORIGINAL = { ...process.env }
beforeEach(() => {
  process.env = { ...ORIGINAL }
})

test('production defaults to queue', () => {
  Object.assign(process.env, { NODE_ENV: 'production' })
  delete process.env.EXECUTION_MODE
  assert.equal(resolveExecutionMode(), 'queue')
})

test('development defaults to inline', () => {
  Object.assign(process.env, { NODE_ENV: 'development' })
  delete process.env.EXECUTION_MODE
  assert.equal(resolveExecutionMode(), 'inline')
})

test('empty-string EXECUTION_MODE falls back to the NODE_ENV default (production → queue)', () => {
  // The 2026-08-04 trap: Vercel env CLI can store an EMPTY value, which reads
  // as "unset-ish" and silently resolves to queue in production.
  Object.assign(process.env, { NODE_ENV: 'production' })
  process.env.EXECUTION_MODE = ''
  assert.equal(resolveExecutionMode(), 'queue')
})

test('an unset or invalid EXECUTION_MODE in production warns about the inferred mode', () => {
  Object.assign(process.env, { NODE_ENV: 'production' })
  process.env.EXECUTION_MODE = ''
  const warnings: unknown[][] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  try {
    resolveExecutionMode()
  } finally {
    console.warn = original
  }
  assert.equal(warnings.length, 1)
  assert.match(String(warnings[0][0]), /EXECUTION_MODE/)

  // An explicit literal must stay silent.
  warnings.length = 0
  process.env.EXECUTION_MODE = 'queue'
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  try {
    resolveExecutionMode()
  } finally {
    console.warn = original
  }
  assert.equal(warnings.length, 0)
})

test('explicit EXECUTION_MODE overrides the default', () => {
  Object.assign(process.env, { NODE_ENV: 'production' })
  process.env.EXECUTION_MODE = 'inline'
  assert.equal(resolveExecutionMode(), 'inline')
  process.env.EXECUTION_MODE = 'queue'
  Object.assign(process.env, { NODE_ENV: 'development' })
  assert.equal(resolveExecutionMode(), 'queue')
})
