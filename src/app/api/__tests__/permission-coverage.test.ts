import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { UNGATED_ROUTES } from '@/lib/authz/ungated-routes'

const apiDir = path.dirname(fileURLToPath(import.meta.url)).replace(/\/__tests__$/, '')

function routeFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__') continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) routeFiles(full, acc)
    else if (entry === 'route.ts') acc.push(full)
  }
  return acc
}

const files = routeFiles(apiDir)
const relative = (file: string) => path.relative(apiDir, file).replace(/\/route\.ts$/, '')

// Match the CALL, not a prose mention: several routes explain in a comment why
// they don't use the wrapper, and a bare substring check reads those as gated.
const usesWrapper = (file: string) => readFileSync(file, 'utf8').includes('withAuthenticatedApi(')

test('every route either goes through the auth wrapper or is a declared exemption', () => {
  const exempt = new Set(UNGATED_ROUTES)
  const unexplained = files
    .filter((file) => !usesWrapper(file))
    .map(relative)
    .filter((route) => !exempt.has(route))

  assert.deepEqual(unexplained, [], `these routes bypass auth without being declared in UNGATED_ROUTES: ${unexplained.join(', ')}`)
})

test('the exemption list has no stale entries', () => {
  const actual = new Set(files.map(relative))
  const stale = UNGATED_ROUTES.filter((route) => !actual.has(route))
  assert.deepEqual(stale, [], `UNGATED_ROUTES names routes that no longer exist: ${stale.join(', ')}`)
})

test('every wrapped route declares the permission it needs', () => {
  const missing = files
    .filter((file) => usesWrapper(file) && !readFileSync(file, 'utf8').includes('permission:'))
    .map(relative)

  assert.deepEqual(missing, [], `these routes are authenticated but declare no permission: ${missing.join(', ')}`)
})
