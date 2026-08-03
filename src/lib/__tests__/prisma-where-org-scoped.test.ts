import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ORG_SCOPED_MODELS } from '@/lib/tenant-guard'

/**
 * The tenant guard throws at RUN TIME. That is the right behavior for a leak,
 * but it makes an unscoped query indistinguishable from a feature that simply
 * does not work — and it is only as loud as the call site lets it be:
 *
 *   - `POST /api/flows/[id]/publish` looked up the latest snapshot with
 *     `where: { flowId }`. Every publish 500'd, which meant no flow could be
 *     armed for a webhook/schedule/signal trigger at all.
 *   - The interpreter's cancellation poll, the HTTP-credential health writes,
 *     and the agent-connector sync all sat inside `.catch()`/try-swallow
 *     blocks, so the guard's throw was eaten and the feature just silently
 *     never worked.
 *
 * A shipped test suite never noticed, because none of those paths had a test
 * that reached the query. This check does what the runtime guard cannot: it
 * reads the source and fails the build when an org-carrying model is queried
 * with a literal `where` object that names no organizationId.
 *
 * SCOPE OF THE CHECK, deliberately narrow to stay signal-only:
 *   - Only `prisma.<model>.<op>({ where: { … } })` with a LITERAL where object.
 *     A `where` built in a variable, passed by shorthand, or carrying a spread
 *     is not statically decidable, so it is skipped rather than guessed at.
 *   - `systemPrisma` is exempt by design — it is the documented escape hatch,
 *     and each of its call sites carries a justification comment.
 * Everything it does flag is the mistake that has actually shipped: forgetting
 * the scope entirely on an inline where.
 */

const SRC = fileURLToPath(new URL('../..', import.meta.url))

const GUARDED_OPERATIONS = [
  'findFirst', 'findFirstOrThrow', 'findMany', 'findUnique', 'findUniqueOrThrow',
  'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany',
  'count', 'aggregate', 'groupBy',
]

/** Prisma's client property for a model: `AgentTask` → `agentTask`. */
function clientProperty(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1)
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

/** Blank comments, preserving newlines so reported line numbers stay true. */
function stripComments(source: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, ' ')
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/([^:"'`\\])\/\/[^\n]*/g, (all: string, prefix: string) => prefix + blank(all.slice(1)))
}

/**
 * Return the balanced `{ … }` (or `( … )`) run starting at `start`, skipping
 * over string literals so a brace inside one never closes the block early.
 */
function balanced(source: string, start: number, open: string, close: string): string {
  let depth = 0
  for (let i = start; i < source.length; i += 1) {
    const char = source[i]
    if (char === '"' || char === "'" || char === '`') {
      const quote = char
      i += 1
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i += 1
        i += 1
      }
      continue
    }
    if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return source.slice(start)
}

type Offender = { file: string; line: number; model: string; operation: string; where: string }

function scan(): Offender[] {
  const models = [...ORG_SCOPED_MODELS].map(clientProperty).sort()
  const call = new RegExp(
    String.raw`\bprisma\.(${models.join('|')})\.(${GUARDED_OPERATIONS.join('|')})\s*\(`,
    'g',
  )
  const offenders: Offender[] = []

  for (const file of sourceFiles(SRC)) {
    const source = stripComments(readFileSync(file, 'utf8'))
    for (const match of source.matchAll(call)) {
      // `systemPrisma.` also ends in `prisma.` — it is the documented exemption.
      if (source.slice(Math.max(0, match.index - 6), match.index).endsWith('system')) continue
      const args = balanced(source, match.index + match[0].length - 1, '(', ')')
      const whereStart = args.search(/\bwhere\s*:\s*\{/)
      if (whereStart < 0) continue // shorthand / variable / no where — not decidable here
      const where = balanced(args, args.indexOf('{', whereStart), '{', '}')
      if (where.includes('...')) continue // spread of a scoped object — not decidable here
      if (where.includes('organizationId')) continue
      offenders.push({
        file: path.relative(SRC, file),
        line: source.slice(0, match.index).split('\n').length,
        model: match[1],
        operation: match[2],
        where: where.replace(/\s+/g, ' ').slice(0, 120),
      })
    }
  }
  return offenders
}

test('every literal where on an org-scoped model carries organizationId', () => {
  const offenders = scan()
  assert.deepEqual(
    offenders,
    [],
    `Unscoped Prisma queries — the tenant guard throws on these at run time:\n${offenders
      .map((o) => `  ${o.file}:${o.line}  prisma.${o.model}.${o.operation}  where: ${o.where}`)
      .join('\n')}\nAdd organizationId to the where, or use systemPrisma with a justification comment.`,
  )
})

test('the scan actually recognizes an unscoped call (guards against a silently dead check)', () => {
  // Same shape the publish route shipped with. If the regex/brace-walking ever
  // stops matching real code, this fails instead of the suite going quietly green.
  const sample = `
    const latest = await prisma.flowVersion.findFirst({
      where: { flowId: id },
      orderBy: { version: 'desc' },
    })
  `
  const models = [...ORG_SCOPED_MODELS].map(clientProperty).sort()
  const call = new RegExp(String.raw`\bprisma\.(${models.join('|')})\.(${GUARDED_OPERATIONS.join('|')})\s*\(`, 'g')
  const match = [...sample.matchAll(call)]
  assert.equal(match.length, 1, 'the call pattern still matches a real prisma call')
  const args = balanced(sample, match[0].index + match[0][0].length - 1, '(', ')')
  const where = balanced(args, args.indexOf('{', args.search(/\bwhere\s*:\s*\{/)), '{', '}')
  assert.ok(!where.includes('organizationId'), 'and the where extraction is precise enough to see the omission')
})
