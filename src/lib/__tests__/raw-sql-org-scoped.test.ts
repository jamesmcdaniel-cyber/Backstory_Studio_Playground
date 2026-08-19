import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Raw SQL is invisible to the tenant guard.
 *
 * The guard is a Prisma client extension, so it sees model operations and
 * nothing else — `$queryRaw` and `$executeRaw` go straight to Postgres with no
 * check at all. That is a documented hole in src/lib/tenant-guard.ts, and the
 * only reason it has never leaked is that every raw statement happens to be
 * org-scoped. "Happens to be" is not a guarantee; this test makes it one.
 *
 * Every raw statement that touches rows must filter on organizationId. The
 * exceptions are statements that touch no rows at all — session settings and
 * the health probe — which are enumerated rather than pattern-matched, so a new
 * unscoped statement fails here instead of shipping.
 *
 * This is a static check on source text. It cannot prove the filter is correct,
 * only that one is present — which is exactly the class of mistake (forgetting
 * it entirely) that the guard catches for non-raw queries.
 */

const SRC = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Files whose raw SQL is deliberately CROSS-TENANT.
 *
 * The operator console's whole job is the view no single workspace can see —
 * "which model is costing us money across every customer" has no org filter by
 * definition, so requiring one would make the surface impossible rather than
 * safe. That is a real exception, not a loophole, so it is enumerated here with
 * a reason, in the same spirit as the "touches no rows" list above.
 *
 * The exemption is CONDITIONAL, and the test below enforces the condition: an
 * exempt file must be an /api/admin route that requires platform.administer and
 * carries internalOnly, so cross-tenant SQL cannot be smuggled into a
 * customer-reachable endpoint by adding a line here.
 */
const CROSS_TENANT_BY_DESIGN: Record<string, string> = {
  'app/api/admin/models/route.ts':
    'Per-model cost and p95 latency across every workspace. Prisma groupBy has no percentile aggregate, and an org filter would defeat the purpose of the view.',
}

/** Statements that touch no rows, so org scope is meaningless for them. */
function touchesNoRows(sql: string): boolean {
  const normalized = sql.trim().replace(/\s+/g, ' ').toUpperCase()
  return normalized.startsWith('SET ') || normalized === 'SELECT 1'
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry.name) && statSync(full).isFile()) out.push(full)
  }
  return out
}

type RawSite = { file: string; line: number; sql: string }

/**
 * Blank out comments, preserving newlines so reported line numbers stay true.
 * Without this the scan trips over prose in tenant-guard.ts that names these
 * very methods.
 */
function stripComments(source: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, ' ')
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/([^:"'`\\])\/\/[^\n]*/g, (_all, prefix: string) => prefix + blank(_all.slice(1)))
}

/** Skip a generic argument list, e.g. the `<Array<{ id: string }>>` in $queryRaw<...>``. */
function skipGenerics(source: string, index: number): number {
  if (source[index] !== '<') return index
  let depth = 0
  let cursor = index
  while (cursor < source.length) {
    if (source[cursor] === '<') depth += 1
    else if (source[cursor] === '>') {
      depth -= 1
      if (depth === 0) return cursor + 1
    }
    cursor += 1
  }
  return index
}

/**
 * Pull the statement text out of each raw call. Both spellings are covered:
 * the tagged-template form (`$executeRaw`...``, with or without a generic) and
 * the string form (`$executeRawUnsafe('...')`). The leading dot is required so
 * only real method calls match.
 */
function rawSites(rawSource: string, file: string): RawSite[] {
  const source = stripComments(rawSource)
  const sites: RawSite[] = []
  const call = /\.\$(?:query|execute)Raw(?:Unsafe)?/g
  let match: RegExpExecArray | null

  while ((match = call.exec(source))) {
    let index = match.index + match[0].length
    while (index < source.length && /\s/.test(source[index])) index += 1
    index = skipGenerics(source, index)
    while (index < source.length && /\s/.test(source[index])) index += 1

    let sql: string | null = null
    const opener = source[index]
    if (opener === '`') {
      const end = source.indexOf('`', index + 1)
      if (end !== -1) sql = source.slice(index + 1, end)
    } else if (opener === '(') {
      // First quoted argument of the Unsafe form.
      const quote = source.slice(index).match(/^[(\s]*(['"`])/)
      if (quote) {
        const start = index + source.slice(index).indexOf(quote[1]) + 1
        const end = source.indexOf(quote[1], start)
        if (end !== -1) sql = source.slice(start, end)
      }
    }

    if (sql === null) {
      // An unparseable shape is reported rather than skipped — silently
      // ignoring it would be the same blind spot in a new costume.
      sql = '<unparsed>'
    }
    sites.push({ file, line: source.slice(0, match.index).split('\n').length, sql })
  }
  return sites
}

test('every raw SQL statement that touches rows filters on organizationId', () => {
  const offenders: string[] = []

  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8')
    if (!/\$(?:query|execute)Raw/.test(source)) continue

    const relative = path.relative(SRC, file)
    for (const site of rawSites(source, file)) {
      if (touchesNoRows(site.sql)) continue
      if (site.sql.includes('organizationId')) continue
      if (CROSS_TENANT_BY_DESIGN[relative]) continue
      offenders.push(
        `${path.relative(SRC, site.file)}:${site.line} — ${site.sql.trim().replace(/\s+/g, ' ').slice(0, 120)}`,
      )
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'Raw SQL without an organizationId filter (the tenant guard cannot see these):\n' + offenders.join('\n'),
  )
})

test('every cross-tenant exemption is an operator-only route', () => {
  // The exemption above is what makes unscoped SQL possible at all, so its
  // precondition is checked rather than trusted. Without this, adding a path to
  // that list would be enough to ship an unscoped query on a customer-reachable
  // endpoint — the exemption would become the hole it exists to bound.
  for (const [relative, reason] of Object.entries(CROSS_TENANT_BY_DESIGN)) {
    assert.ok(reason.trim().length > 20, `${relative} needs a written reason, not a placeholder`)
    assert.match(relative, /^app\/api\/admin\//, `${relative} must be an operator route to read across tenants`)
    const source = readFileSync(path.join(SRC, relative), 'utf8')
    assert.match(source, /permission: 'platform\.administer'/, `${relative} must require the operator tier`)
    assert.match(source, /internalOnly: true/, `${relative} must be absent from the customer edition`)
  }
})

test('the scan actually finds the known raw SQL sites', () => {
  // A self-check: if the parser silently stopped matching, the test above would
  // pass by finding nothing at all, which is the failure mode that matters.
  let found = 0
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8')
    if (!/\$(?:query|execute)Raw/.test(source)) continue
    found += rawSites(source, file).length
  }
  assert.ok(found >= 10, `expected the pgvector/health raw sites to be found, saw ${found}`)
})
