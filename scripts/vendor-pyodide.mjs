// Serve in-browser Python to artifact pages: copy pyodide's browser runtime
// (and the numpy/pandas wheels a page may import) from node_modules/pyodide
// into public/vendor/pyodide at build time. Too large to commit (~20 MB), and
// the worker already depends on the same pyodide release, so the page and the
// worker run one Python. Best effort: a build without network still ships the
// core (no numpy/pandas); a build without pyodide at all ships no Python.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const out = path.join(process.cwd(), 'public', 'vendor', 'pyodide')
const CORE = ['pyodide.js', 'pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']

let dir
try {
  dir = path.dirname(require.resolve('pyodide/package.json'))
} catch {
  console.warn('vendor-pyodide: pyodide is not installed; artifact pages will not run Python.')
  process.exit(0)
}

try {
  // Fetches the wheels into pyodide's own directory (its package cache).
  const { loadPyodide } = await import('pyodide')
  const py = await loadPyodide({ stdout: () => undefined, stderr: () => undefined })
  await py.loadPackage(['numpy', 'pandas'], { messageCallback: () => undefined })
} catch (error) {
  console.warn(`vendor-pyodide: could not fetch numpy/pandas (${error instanceof Error ? error.message : error}); shipping the core only.`)
}

fs.mkdirSync(out, { recursive: true })
let bytes = 0
for (const name of fs.readdirSync(dir)) {
  if (!CORE.includes(name) && !name.endsWith('.whl')) continue
  fs.copyFileSync(path.join(dir, name), path.join(out, name))
  bytes += fs.statSync(path.join(out, name)).size
}
console.log(`vendor-pyodide: ${(bytes / 1e6).toFixed(1)} MB into public/vendor/pyodide`)

// Source-map comments make browser devtools fetch a .map the artifact sandbox
// (connect-src) refuses — console noise on every page. The maps aren't shipped.
for (const name of fs.readdirSync(out)) {
  if (!/\.m?js$/.test(name)) continue
  const file = path.join(out, name)
  const text = fs.readFileSync(file, 'utf8')
  const stripped = text.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '\n')
  if (stripped !== text) fs.writeFileSync(file, stripped)
}
