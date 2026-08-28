import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Every test file this repo contains must actually be runnable.
 *
 * Node's test runner treats its positional arguments as GLOB PATTERNS, and
 * `[id]` — the Next.js dynamic-route convention this app uses throughout
 * `src/app` — is a character class. So a test placed in, say,
 * `src/app/flows/[id]/__tests__/` is never matched by any of the forms `npm
 * test` could pass it: not the literal path, not an escaped one, not an
 * absolute one. The run prints `# tests 0` and exits 0.
 *
 * That failure mode is silent in both directions: `find` lists the file, git
 * shows it, a reviewer sees tests — and none of them run. This is a plausible
 * reason the largest component in the app, `src/app/flows/[id]/page.tsx`, went
 * so long with no tests: anyone who tried would have watched them "pass".
 *
 * Tests for a dynamic-route page belong in the nearest non-bracketed
 * `__tests__` directory (e.g. `src/app/flows/__tests__/`), which is exactly
 * where the flow editor's now are.
 */

const SRC = path.join(process.cwd(), 'src')

function testFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue
      testFiles(full, acc)
    } else if (/\.test\.tsx?$/.test(entry)) {
      acc.push(path.relative(SRC, full))
    }
  }
  return acc
}

test('no test file sits under a dynamic-route directory, where the runner cannot glob it', () => {
  const unreachable = testFiles(SRC).filter((file) => file.includes('['))

  assert.deepEqual(
    unreachable,
    [],
    `these test files can never run — Node's test runner globs its arguments and '[' opens a ` +
      `character class, so the file is silently skipped and the run still exits 0: ` +
      `${unreachable.join(', ')}. Move them to the nearest __tests__ directory whose path has no ` +
      `brackets (for a page at src/app/flows/[id]/page.tsx, that is src/app/flows/__tests__/).`,
  )
})
