import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Pins the demo-chrome contract the way layout-contract.test.ts pins the
 * shell's: by source scan, because these failures (chip quietly removed from
 * the sidebar, hide-for-capture becoming hide-forever) are invisible to
 * typecheck and only surface as a marketing session that silently stopped
 * being labelled.
 */
const chip = readFileSync(path.join(process.cwd(), 'src/components/layout/demo-chip.tsx'), 'utf8')
const sidebar = readFileSync(path.join(process.cwd(), 'src/components/layout/sidebar.tsx'), 'utf8')

test('the sidebar mounts both the chip and the menu control', () => {
  assert.match(sidebar, /<DemoChip \/>/)
  assert.match(sidebar, /<DemoModeMenuItem \/>/)
})

test('hide-for-capture restores itself — a timer, not a dismissal', () => {
  assert.match(chip, /HIDE_MS = 60_000/)
  assert.match(chip, /setTimeout\(\(\) => setHidden\(false\), HIDE_MS\)/)
})

test('the chip renders only inside an active demo session and says edits are not saved', () => {
  assert.match(chip, /if \(!active \|\| hidden\) return null/)
  assert.match(chip, /Demo — edits aren&apos;t saved/)
})

test('enter and exit hard-navigate so no cached tenant data survives the switch', () => {
  assert.match(chip, /window\.location\.assign\('\/dashboard'\)/)
})
