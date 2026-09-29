// Pre-fetch the pyodide packages dataset runs need (pandas, numpy) into
// pyodide's package cache at image build time, so the worker never reaches
// for the CDN while a run is waiting. Idempotent: a warm cache is a no-op.
import { loadPyodide } from 'pyodide'

const started = Date.now()
const pyodide = await loadPyodide({ stdout: () => undefined, stderr: () => undefined })
await pyodide.loadPackage(['pandas', 'numpy'], { messageCallback: () => undefined })
const version = pyodide.runPython('import pandas; pandas.__version__')
console.log(`pyodide warm: pandas ${version} cached in ${Date.now() - started} ms`)
