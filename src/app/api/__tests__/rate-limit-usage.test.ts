import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * rateLimit() resolves to { ok, retryAfterMs } — an object, so `if (limited)`
 * is always true and refuses every request. That shipped in three routes (the
 * artifact assistant's chat among them) before this guard: every limiter
 * result must be read through `.ok`.
 */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? (name === '__tests__' || name === 'node_modules' ? [] : files(full)) : /\.tsx?$/.test(name) ? [full] : []
  })
}

test('every rateLimit() result is read through .ok, never as a truthy value', () => {
  const offenders: string[] = []
  for (const file of files(path.join(process.cwd(), 'src'))) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/const (\w+) = await rateLimit\(/g)) {
      if (new RegExp(`if \\(\\s*${match[1]}\\s*\\)`).test(source)) offenders.push(`${path.relative(process.cwd(), file)} (${match[1]})`)
    }
  }
  assert.deepEqual(offenders, [], `rateLimit() results tested for truthiness: ${offenders.join(', ')}`)
})
