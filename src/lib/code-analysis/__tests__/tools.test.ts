import test from 'node:test'
import assert from 'node:assert/strict'
import { CODE_TOOLS, CodeAnalysisToolClient, type LoadedDocument } from '../tools'

const csv = 'rep,close_date,amount\nAna,2026-01-10,"$1,000"\nAna,2026-01-20,3000\nBo,2026-02-02,500\n'
const docs: LoadedDocument[] = [{ id: 'doc-1', filename: 'deals.csv', content: csv, truncated: false }]
const client = (loaded = docs) => new CodeAnalysisToolClient('org', 'user', 'agent', async (ids) => loaded.filter((d) => ids.includes(d.id)))

test('run_code is read-only and requires code', () => {
  assert.deepEqual(CODE_TOOLS.map((t) => [t.name, t.isWrite]), [['run_code', false]])
  assert.deepEqual(CODE_TOOLS[0].inputSchema.required, ['code'])
})

test('computes per-rep monthly averages over a repository CSV', async () => {
  const result = await client().executeTool('', 'run_code', {
    documentIds: ['doc-1'],
    code: [
      'groups = defaultdict(list)',
      'for r in input["files"][0]["rows"]:',
      '    groups[r["rep"] + " " + month_key(r["close_date"])].append(to_number(r["amount"]))',
      'return {k: mean(v) for k, v in sorted(groups.items())}',
    ].join('\n'),
  }) as { output: unknown; files: unknown }
  assert.deepEqual(result.output, { 'Ana 2026-01': 2000, 'Bo 2026-02': 500 })
  assert.deepEqual(result.files, [{ filename: 'deals.csv', rows: 3, columns: ['rep', 'close_date', 'amount'] }])
})

test('runs JavaScript over inline data', async () => {
  const result = await client().executeTool('', 'run_code', {
    language: 'javascript',
    data: [1, 2, 3],
    code: 'return input.data.reduce((a, b) => a + b, 0)',
  }) as { output: unknown }
  assert.equal(result.output, 6)
})

test('refuses documents outside the caller scope instead of running on nothing', async () => {
  const result = await client().executeTool('', 'run_code', { documentIds: ['doc-other'], code: 'return 1' }) as { error: string }
  assert.match(result.error, /doc-other/)
})

test('warns when the source file was truncated at ingest', async () => {
  const result = await client([{ ...docs[0], truncated: true }]).executeTool('', 'run_code', {
    documentIds: ['doc-1'],
    code: 'return len(input["files"][0]["rows"])',
  }) as { output: unknown; warnings: string[] }
  assert.equal(result.output, 3)
  assert.match(result.warnings[0], /truncated/)
})

test('returns a code error to the agent as a retryable result, not a throw', async () => {
  const result = await client().executeTool('', 'run_code', { code: 'return 1 / 0' }) as { error: string; hint: string }
  assert.match(result.error, /division/)
  assert.match(result.hint, /run_code again/)
})
