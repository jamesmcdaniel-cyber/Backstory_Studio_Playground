import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

/**
 * The app shell owns two things and pages own neither: the VIEWPORT HEIGHT and
 * the CONTENT MEASURE (width, centering, gutters).
 *
 * When pages restated those themselves the chrome visibly changed shape as you
 * navigated — /agents declared its own 100vh inside an already-viewport-tall
 * <main>, so the shell overflowed the window (page-level scrollbar, sidebar
 * footer clipped, canvas showing at the edges), while /dashboard, /flows,
 * /approvals and /settings each centered on a different max-width so the
 * content's left and right edges jumped route to route.
 *
 * These tests pin the contract by scanning page sources, because the failure is
 * invisible to typecheck and only shows up as a layout that "shrinks" on one tab.
 */

const APP_DIR = path.join(process.cwd(), 'src/app')

// Route prefixes rendered inside <AppShell> (mirrors APP_PREFIXES there).
const SHELL_PREFIXES = ['dashboard', 'agents', 'integrations', 'connections', 'templates', 'flows', 'approvals', 'settings', 'admin']

/**
 * Class names live in JSX, and so do the comments explaining why a class is NOT
 * used — scan the code only, or every "never use h-screen here" note reads as a
 * violation of itself.
 */
function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function pageFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...pageFiles(full))
    else if (entry.name === 'page.tsx') out.push(full)
  }
  return out
}

const shellPages = SHELL_PREFIXES.flatMap((prefix) => {
  const dir = path.join(APP_DIR, prefix)
  try {
    return pageFiles(dir)
  } catch {
    return [] // route folded into another surface (e.g. /templates redirects)
  }
}).map((file) => ({ file: path.relative(process.cwd(), file), source: stripComments(readFileSync(file, 'utf8')) }))

const shellSource = stripComments(readFileSync(path.join(process.cwd(), 'src/components/layout/app-shell.tsx'), 'utf8'))

test('every shell route still has a page to check', () => {
  assert.ok(shellPages.length >= 6, `expected the shell's pages, found ${shellPages.length}`)
})

test('no page inside the shell claims a viewport height', () => {
  // h-screen / min-h-screen = 100vh, which is a SECOND claim on a region the
  // shell already sized to the viewport — and on mobile browsers 100vh exceeds
  // the visible area, so the shell overflows by the height of the browser UI.
  // Pages fill their region with h-full instead.
  const offenders = shellPages
    .filter(({ source }) => /(?:^|[\s"'`:])(?:lg:|sm:|md:|xl:)?(?:min-)?h-screen\b/.test(source))
    .map(({ file }) => file)
  assert.deepEqual(offenders, [], `these pages restate the viewport height instead of using h-full: ${offenders.join(', ')}`)
})

test('no page inside the shell centers itself on its own max-width', () => {
  // `mx-auto max-w-*` on a page root fights the shell's PAGE_CONTAINER: the page
  // ends up centered inside an already-centered box, at a width no other route
  // shares. A narrower reading column is fine (`max-w-2xl` on settings) as long
  // as it does not re-center — it must keep the shell's left edge.
  const offenders = shellPages
    .filter(({ source }) => /className="[^"]*\bmx-auto\b[^"]*\bmax-w-(?:3xl|4xl|5xl|6xl|7xl|screen-\w+)\b/.test(source))
    .map(({ file }) => file)
  assert.deepEqual(offenders, [], `these pages define their own content measure: ${offenders.join(', ')}`)
})

test('the shell defines exactly one content measure', () => {
  const measures = shellSource.match(/max-w-[\w[\]-]+/g) ?? []
  assert.deepEqual([...new Set(measures)], ['max-w-6xl'], 'the shell should declare one page width')
  assert.match(shellSource, /h-dvh/, 'the shell sizes itself with h-dvh, not 100vh')
  assert.doesNotMatch(shellSource, /h-screen/, 'h-screen overflows the visible viewport on mobile browsers')
})

test('the shell geometry pin survives page-level CSS the app did not write', () => {
  // Extensions that "unlock" scroll-locked pages rewrite the box model of the
  // outermost containers; the reported symptom was the whole app inset 24px
  // with a page-level scrollbar (shell at 24,24 in a viewport-sized body).
  // The pin states the shell's actual geometry, so a foreign author-origin
  // stylesheet can no longer move it. Removing either half re-opens the bug.
  const globals = readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8')
  assert.match(shellSource, /app-shell-root/, 'the shell root needs the class the pin targets')
  assert.match(globals, /html:root > body > \.app-shell-root/, 'globals.css must pin the shell root box')
  assert.match(globals, /html:root > body > \*\s*\{[^}]*margin:\s*0\s*!important/, 'direct body children must be margin-pinned')
})

test('fullscreen routing ignores a trailing slash', () => {
  // A trailing slash silently dropped /agents into the centered container —
  // the same page rendering at two different widths depending on the URL.
  assert.match(shellSource, /normalizePath/, 'pathname must be normalized before the layout decision')
})
