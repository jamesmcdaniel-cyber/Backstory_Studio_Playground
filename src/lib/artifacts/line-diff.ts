/**
 * A line diff for the History tab's "Compare with current": the longest common
 * subsequence of the two versions' lines, read back as kept, added and removed
 * lines. Small and client-side; the `diff` package is not a dependency.
 */
export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string; oldLine?: number; newLine?: number }
export type LineDiff = { lines: DiffLine[]; added: number; removed: number; truncated: boolean }

/** Past this many lines a side, the diff is computed on a prefix (the table is quadratic). */
export const LINE_DIFF_MAX_LINES = 4_000

export function lineDiff(before: string, after: string): LineDiff {
  const a = before.split('\n'), b = after.split('\n')
  const truncated = a.length > LINE_DIFF_MAX_LINES || b.length > LINE_DIFF_MAX_LINES
  const n = Math.min(a.length, LINE_DIFF_MAX_LINES), m = Math.min(b.length, LINE_DIFF_MAX_LINES)
  // Shared prefix and suffix first: a one-line change in a long page costs nothing.
  let start = 0
  while (start < n && start < m && a[start] === b[start]) start++
  let endA = n, endB = m
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const rows = endA - start, cols = endB - start
  // table[i][j]: the LCS length of a[start+i..endA) and b[start+j..endB).
  const width = cols + 1
  const table = new Uint32Array((rows + 1) * width)
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i * width + j] = a[start + i] === b[start + j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  const lines: DiffLine[] = []
  let added = 0, removed = 0
  for (let k = 0; k < start; k++) lines.push({ kind: 'same', text: a[k], oldLine: k + 1, newLine: k + 1 })
  let i = 0, j = 0
  while (i < rows || j < cols) {
    if (i < rows && j < cols && a[start + i] === b[start + j]) { lines.push({ kind: 'same', text: a[start + i], oldLine: start + i + 1, newLine: start + j + 1 }); i++; j++ }
    // On a tie the removed line comes first, as a reader expects (old, then new).
    else if (i < rows && (j >= cols || table[(i + 1) * width + j] >= table[i * width + j + 1])) { lines.push({ kind: 'removed', text: a[start + i], oldLine: start + i + 1 }); removed++; i++ }
    else { lines.push({ kind: 'added', text: b[start + j], newLine: start + j + 1 }); added++; j++ }
  }
  for (let k = 0; k < n - endA; k++) lines.push({ kind: 'same', text: a[endA + k], oldLine: endA + k + 1, newLine: endB + k + 1 })
  return { lines, added, removed, truncated }
}

export type FoldedLine = DiffLine | { kind: 'fold'; count: number }

/** The diff with unchanged runs folded to `context` lines either side of a change. */
export function foldUnchanged(diff: LineDiff, context = 3): FoldedLine[] {
  const out: FoldedLine[] = []
  let run: DiffLine[] = []
  const flush = (atEnd: boolean) => {
    const keepStart = out.length ? context : 0
    const keepEnd = atEnd ? 0 : context
    if (run.length <= keepStart + keepEnd) out.push(...run)
    else {
      out.push(...run.slice(0, keepStart))
      out.push({ kind: 'fold', count: run.length - keepStart - keepEnd })
      if (keepEnd) out.push(...run.slice(run.length - keepEnd))
    }
    run = []
  }
  for (const line of diff.lines) {
    if (line.kind === 'same') run.push(line)
    else { flush(false); out.push(line) }
  }
  flush(true)
  return out
}
