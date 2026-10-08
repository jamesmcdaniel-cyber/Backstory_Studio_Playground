import test from 'node:test'
import assert from 'node:assert/strict'
import { foldUnchanged, lineDiff, LINE_DIFF_MAX_LINES } from '../line-diff'

const kinds = (before: string, after: string) => lineDiff(before, after).lines.map((line) => `${line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}${line.text}`)

test('a line diff keeps common lines and marks what was added and removed', () => {
  const diff = lineDiff('a\nb\nc\nd', 'a\nx\nc\nd\ne')
  assert.deepEqual(diff.lines.map((l) => l.kind), ['same', 'removed', 'added', 'same', 'same', 'added'])
  assert.equal(diff.added, 2)
  assert.equal(diff.removed, 1)
  assert.equal(diff.truncated, false)
  // Line numbers follow each side.
  assert.deepEqual(diff.lines.map((l) => [l.oldLine ?? null, l.newLine ?? null]), [[1, 1], [2, null], [null, 2], [3, 3], [4, 4], [null, 5]])
})

test('identical content has no changes; empty sides are all added or all removed', () => {
  const same = lineDiff('one\ntwo', 'one\ntwo')
  assert.equal(same.added + same.removed, 0)
  assert.deepEqual(kinds('', 'a\nb'), ['-', '+a', '+b'])
  assert.deepEqual(kinds('a\nb', ''), ['-a', '-b', '+'])
})

test('a one-line change deep in a long page is found through the shared prefix and suffix', () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`)
  const before = lines.join('\n')
  const after = lines.map((l, i) => (i === 1500 ? 'changed' : l)).join('\n')
  const diff = lineDiff(before, after)
  assert.equal(diff.added, 1)
  assert.equal(diff.removed, 1)
  assert.equal(diff.lines.length, 3001)
  const folded = foldUnchanged(diff, 2)
  // Two folds either side of the change, with two context lines each.
  assert.deepEqual(folded.map((l) => l.kind), ['fold', 'same', 'same', 'removed', 'added', 'same', 'same', 'fold'])
  assert.equal((folded[0] as { count: number }).count, 1498)
})

test('a page past the line cap is compared on its prefix and says so', () => {
  const big = Array.from({ length: LINE_DIFF_MAX_LINES + 10 }, (_, i) => String(i)).join('\n')
  const diff = lineDiff(big, big + '\nextra')
  assert.equal(diff.truncated, true)
})

test('folding keeps every changed line and never folds a short run', () => {
  const diff = lineDiff('a\nb\nc', 'a\nB\nc')
  assert.deepEqual(foldUnchanged(diff).map((l) => l.kind), ['same', 'removed', 'added', 'same'])
})
