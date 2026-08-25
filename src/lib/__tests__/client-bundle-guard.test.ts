import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * A client component must not reach the server data layer.
 *
 * `mcp-step-suggestion.ts` imported one three-line helper from a module that
 * imports prisma. Webpack followed prisma into cache.ts, into ioredis, into
 * `dns`/`net`/`tls` — and the production build failed on modules nothing in a
 * browser was ever going to call. Typecheck passed, the unit suite passed, and
 * the break only appeared in `next build`.
 *
 * So this walks the real import graph from every `'use client'` file and fails
 * on the first path that reaches a server-only module. It is the cheap version
 * of the bundler's own resolution, and it runs in the suite that gates a push.
 */

const SRC = path.join(process.cwd(), 'src')

/** Modules that pull in a Node-only dependency tree. */
const SERVER_ONLY = ['@/lib/prisma', '@/lib/cache', '@/lib/queue/config', '@/lib/outbox']

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') walkFiles(full, out)
    } else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/** `@/x` → absolute path, resolving the extension the file actually has. */
function resolveAlias(spec: string): string | null {
  if (!spec.startsWith('@/')) return null
  const base = path.join(SRC, spec.slice(2))
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      /* not this one */
    }
  }
  return null
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  return [...source.matchAll(/from\s+'(@\/[^']+)'/g)].map((match) => match[1])
}

test('no client component reaches the server data layer', () => {
  const files = walkFiles(SRC)
  const clientEntries = files.filter((file) => {
    const head = readFileSync(file, 'utf8').slice(0, 200)
    return head.includes("'use client'") || head.includes('"use client"')
  })
  assert.ok(clientEntries.length > 20, `expected many client components, found ${clientEntries.length}`)

  const offenders: string[] = []
  for (const entry of clientEntries) {
    // Breadth-first to the first server-only module, keeping the path that got
    // there — "step-drawer imports prisma somehow" is not an actionable failure.
    const queue: Array<{ file: string; trail: string[] }> = [{ file: entry, trail: [entry] }]
    const seen = new Set([entry])
    while (queue.length) {
      const { file, trail } = queue.shift()!
      for (const spec of importsOf(file)) {
        if (SERVER_ONLY.includes(spec)) {
          offenders.push(`${trail.map((f) => path.relative(SRC, f)).join(' → ')} → ${spec}`)
          queue.length = 0
          break
        }
        const next = resolveAlias(spec)
        if (!next || seen.has(next)) continue
        seen.add(next)
        queue.push({ file: next, trail: [...trail, next] })
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `client components reaching server-only modules:\n  ${offenders.join('\n  ')}\n` +
      'Move the shared helper into a leaf module with no server imports.',
  )
})
