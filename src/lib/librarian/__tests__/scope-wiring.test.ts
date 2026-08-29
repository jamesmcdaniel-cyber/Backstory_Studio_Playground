import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { scopeRule } from '@/lib/security/scope'

/**
 * The scope tiers are only worth anything if they are actually wired.
 *
 * `scopeRule` can be perfect and every unit test on it green while the route
 * never calls it, or calls it with a hardcoded tier, or the dashboard quietly
 * stops sending its mode and drops to the helper's narrower ground — a
 * regression that shows up as a slightly worse answer, never as a failure. None
 * of that is visible from inside the module, so this reads the source files, the
 * same way lib/security/__tests__/llm-fencing-coverage.test.ts does.
 *
 * It is a wiring guard, not a unit test: it asserts on text, and text
 * assertions are brittle by design here. A refactor that renames these things
 * SHOULD stop and re-read this file, because the composition it pins is the
 * whole security boundary of both surfaces.
 *
 * The caller list is derived from the filesystem rather than enumerated. A
 * third surface on this endpoint is exactly the case an enumerated list misses,
 * and the default it would silently inherit is the one the model is not told
 * about.
 */

const SRC = path.join(process.cwd(), 'src')
const ROUTE = path.join(SRC, 'app', 'api', 'librarian', 'route.ts')

/** How a file betrays that it is a user-facing caller of the librarian. */
const LIBRARIAN_FETCH = /fetch\(\s*['"`]\/api\/librarian['"`]/

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      sourceFiles(full, acc)
    } else if (/\.tsx?$/.test(entry)) {
      acc.push(full)
    }
  }
  return acc
}

function librarianCallers(): string[] {
  return sourceFiles(SRC)
    .filter((file) => LIBRARIAN_FETCH.test(readFileSync(file, 'utf8')))
    .map((file) => path.relative(SRC, file))
}

const route = readFileSync(ROUTE, 'utf8')

test('the caller detector still finds the surfaces it is meant to guard', () => {
  // Without this, a rename of the endpoint would leave every assertion below
  // iterating an empty list and passing vacuously.
  const callers = librarianCallers()
  assert.ok(callers.length >= 2, `expected both librarian surfaces, found ${callers.length}: ${callers.join(', ')}`)
})

test('the route accepts a mode and defaults it to the tighter tier', () => {
  assert.match(
    route,
    /mode:\s*z\.enum\(\s*\[\s*'helper',\s*'assistant'\s*\]\s*\)\.default\('helper'\)/,
    'requestSchema must accept both tiers and default to helper',
  )
})

test('the route holds the model to the mode it was given, not to a tier of its own choosing', () => {
  assert.match(route, /from '@\/lib\/security\/scope'/, 'the route must import from lib/security/scope')
  assert.match(route, /const \{[^}]*\bmode\b[^}]*\} = requestSchema\.parse/, 'mode must be read off the parsed request')
  assert.match(route, /scopeRule\(mode\)/, 'scopeRule must be applied to the request mode')
  // A literal tier here would make the field decorative — the widget would send
  // 'helper', the schema would accept it, and the model would be told otherwise.
  assert.ok(!/scopeRule\(\s*['"]/.test(route), 'scopeRule must never be called with a hardcoded tier')
})

test('the system prompt carries the base prompt, the scope clause and the guardrails together', () => {
  assert.match(route, /from '@\/lib\/security\/guardrails'/, 'the librarian was the last model surface without GUARDRAIL_RULE')
  assert.match(
    route,
    /system: `\$\{SYSTEM_PROMPT\}\\n\\n\$\{scopeRule\(mode\)\}\\n\\n\$\{GUARDRAIL_RULE\}`/,
    'the three clauses must be composed in the route, in that order',
  )
})

test('mode reaches the system prompt and nothing else, so the two tiers retrieve identically', () => {
  // One brain, two scopes: if `mode` ever reached retrieval, candidate assembly
  // or citation resolution, the numbering the RELEVANT: line resolves against
  // would differ between surfaces and the tiers would be two systems wearing one
  // name. The only legitimate readers are the schema, the destructure, and the
  // scope clause — three, and this counts them.
  const code = route.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  // Prisma's `mode: 'insensitive'` on the keyword search is a different `mode`
  // that happens to share the word.
  const uses = (code.match(/\bmode\b/g) ?? []).length - (code.match(/mode: 'insensitive'/g) ?? []).length
  assert.equal(uses, 3, `mode should be read in exactly 3 places (schema, destructure, scopeRule), found ${uses}`)
  assert.ok(!/buildPrompt\([^)]*\bmode\b/.test(code), 'mode must not reach buildPrompt — the user turn is identical on both tiers')
})

test('every surface that calls the librarian sends an explicit mode', () => {
  const silent = librarianCallers().filter((relative) => {
    const source = readFileSync(path.join(SRC, relative), 'utf8')
    return !/\bmode:\s*['"](helper|assistant)['"]/.test(source)
  })

  assert.deepEqual(
    silent,
    [],
    `these librarian callers send no mode and would silently inherit the helper default: ${silent.join(', ')}`,
  )
})

test('the corner widget asks as the helper and the dashboard home asks as the assistant', () => {
  const widget = readFileSync(path.join(SRC, 'components', 'assistant', 'ask-backstory.tsx'), 'utf8')
  const dashboard = readFileSync(path.join(SRC, 'app', 'dashboard', 'page.tsx'), 'utf8')

  assert.match(widget, /mode:\s*'helper'/, 'the in-product helper is the narrower tier')
  assert.match(dashboard, /mode:\s*'assistant'/, 'the dashboard home also covers go-to-market work')
})

test('both tiers a caller can send are tiers scopeRule actually distinguishes', () => {
  // Pins the two ends together: the strings in the callers are the strings the
  // module branches on, so a typo in a fetch body cannot resolve to the default
  // and look like it worked.
  const sent = new Set<string>()
  for (const relative of librarianCallers()) {
    const source = readFileSync(path.join(SRC, relative), 'utf8')
    for (const match of source.matchAll(/\bmode:\s*['"]([a-z]+)['"]/g)) sent.add(match[1])
  }

  assert.deepEqual([...sent].sort(), ['assistant', 'helper'], 'both tiers should be in live use, and only those two')
  assert.notEqual(scopeRule('helper'), scopeRule('assistant'), 'the tiers must actually differ, or the mode is theatre')
})
