import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getQuickJS } from 'quickjs-emscripten'
import { loadPyodide } from 'pyodide'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverDir = path.join(root, '.next', 'server')

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(target) : [target]
  }))
  return files.flat()
}

const serverFiles = await walk(serverDir)
const javascriptFiles = serverFiles.filter((file) => file.endsWith('.js'))
let bundledRunner = false
for (const file of javascriptFiles) {
  const source = await fs.readFile(file, 'utf8')
  if (source.includes('flow-code.js') && source.includes('__flow_user__')) bundledRunner = true
}
assert.ok(bundledRunner, 'The production server bundle does not contain the flow-code runner')

// QuickJS and Pyodide are serverExternalPackages (bundling QuickJS broke
// JavaScript code steps inside the Next server): neither is in the bundle, so
// what must hold is that their WASM is TRACED into the functions, compiles,
// and executes — checked below for both.
const traceFiles = serverFiles.filter((file) => file.endsWith('.nft.json'))
const traced = new Set()
for (const traceFile of traceFiles) {
  const trace = JSON.parse(await fs.readFile(traceFile, 'utf8'))
  for (const relativeFile of trace.files ?? []) {
    traced.add(path.resolve(path.dirname(traceFile), relativeFile))
  }
}

const requiredArtifacts = [
  '@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm',
  'pyodide/pyodide.asm.wasm',
  'pyodide/python_stdlib.zip',
]
for (const suffix of requiredArtifacts) {
  const artifact = [...traced].find((file) => file.replaceAll(path.sep, '/').endsWith(suffix))
  assert.ok(artifact, `Production function traces are missing ${suffix}`)
  await fs.access(artifact)
  if (artifact.endsWith('.wasm')) await WebAssembly.compile(await fs.readFile(artifact))
}

// Exercise the public APIs and their real WASM binaries, not package metadata.
const QuickJS = await getQuickJS()
assert.equal(QuickJS.evalCode('6 * 7'), 42, 'QuickJS/WASM did not execute correctly')

const pyodideDir = path.dirname(fileURLToPath(import.meta.resolve('pyodide/pyodide.mjs')))
const pyodide = await loadPyodide({ indexURL: `${pyodideDir}/` })
assert.equal(pyodide.runPython('sum([2, 3, 5])'), 10, 'Pyodide/WASM did not execute correctly')

console.log('✓ production functions trace executable QuickJS/WASM and Pyodide/WASM assets')
