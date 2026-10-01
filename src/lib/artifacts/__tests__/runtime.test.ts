import test from 'node:test'
import assert from 'node:assert/strict'
import { compileArtifactPage, hasJsxScript, reactArtifactDocument, reactComponentOf, reactTitleOf } from '../runtime'
import { unsupportedScripts, vendorScripts } from '../vendor-scripts'

const COMPONENT = `import React, { useState } from 'react';
import { BarChart, Bar } from 'recharts';
import { Card } from '@/components/ui/card';
type Rep = { name: string };
export default function App() {
  const [view, setView] = useState<'overview' | 'reps'>('overview');
  return <Card><h1 className="text-2xl">Pipeline review</h1><button onClick={() => setView('reps')}>{view}</button><BarChart data={[]}><Bar dataKey="v" /></BarChart></Card>;
}`

test('a React component answer is recognised, fenced or raw; prose and HTML are not', () => {
  assert.equal(reactComponentOf(COMPONENT), COMPONENT)
  assert.equal(reactComponentOf('```jsx\n' + COMPONENT + '\n```'), COMPONENT)
  assert.equal(reactComponentOf('```tsx\n' + COMPONENT + '\n```'), COMPONENT)
  assert.equal(reactComponentOf('Here is the dashboard you asked for: it shows pipeline.'), null)
  assert.equal(reactComponentOf('<!doctype html><html><body><h1>x</h1></body></html>'), null)
  assert.equal(reactComponentOf('Use `export default` in your module to expose <App/>.'), null, 'prose that mentions the syntax is not a component')
  assert.equal(reactTitleOf(COMPONENT), 'Pipeline review')
})

test('a component is served as a page whose JSX compiles, with the libraries it imports loaded first', () => {
  const page = reactArtifactDocument(COMPONENT)
  assert.ok(hasJsxScript(page))
  assert.match(page, /<title>Pipeline review<\/title>/)
  const served = compileArtifactPage(page)
  assert.ok(!hasJsxScript(served), 'no JSX left for the browser')
  assert.ok(!/useState<'overview'/.test(served), 'TypeScript is stripped')
  assert.match(served, /React\.createElement|_react2\.default\.createElement/)
  const order = ['__artifactRequire', '/vendor/react.production.min.js', '/vendor/react-dom.production.min.js', '/vendor/prop-types.min.js', '/vendor/recharts.min.js', '__artifactMount(module.exports)']
  const positions = order.map((needle) => served.indexOf(needle))
  assert.ok(positions.every((at) => at >= 0), `all present: ${order.filter((_, i) => positions[i] < 0).join(', ')}`)
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'runtime, then libraries, then the component')
  assert.ok(!served.includes('/vendor/d3.min.js'), 'only what the component imports')
})

test('code that will not compile shows an error panel instead of a blank page', () => {
  const served = compileArtifactPage(reactArtifactDocument('export default function App( { return <div>broken</div> }'))
  assert.match(served, /could not be compiled/)
  assert.match(served, /__artifactError/)
})

test('a page without JSX is served as it is', () => {
  const html = '<!doctype html><html><body><script>document.title = "x"</script></body></html>'
  assert.equal(compileArtifactPage(html), html)
})

test('a text/babel page (React from a CDN, the common Claude HTML shape) runs without Babel', () => {
  const html = '<!doctype html><html><head><script src="https://unpkg.com/react@18/umd/react.production.min.js"></script><script src="https://unpkg.com/@babel/standalone/babel.min.js"></script></head><body><div id="root"></div><script type="text/babel">const App = () => <h1>Hi</h1>; ReactDOM.createRoot(document.getElementById("root")).render(<App />)</script></body></html>'
  const served = compileArtifactPage(vendorScripts(html))
  assert.ok(!/babel/i.test(served.replace(/text\/babel/g, '')), 'Babel standalone is dropped — the server compiles')
  assert.equal((served.match(/\/vendor\/react\.production\.min\.js/g) ?? []).length, 1, 'React is not loaded twice')
  assert.deepEqual(unsupportedScripts(served), [])
})

test('the libraries a Claude artifact loads from CDNs are served from our copies', () => {
  const urls = [
    'https://cdn.jsdelivr.net/npm/chart.js',
    'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
    'https://cdn.tailwindcss.com',
    'https://d3js.org/d3.v7.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
    'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js',
    'https://unpkg.com/recharts@2.12.7/umd/Recharts.js',
  ]
  const html = urls.map((url) => `<script src="${url}"></script>`).join('')
  assert.deepEqual(unsupportedScripts(html), [])
  assert.ok(!/https?:\/\//.test(vendorScripts(html)))
})

test('uploads: HTML stays HTML, a component becomes a React page, other code becomes a runnable code page', async () => {
  const { artifactDocumentForUpload, codeLanguageOf, hasPythonScript } = await import('../runtime')
  const banner = '<!-- build notes -->\n<!DOCTYPE html><html><body><script>1</script></body></html>'
  assert.deepEqual(artifactDocumentForUpload(banner, 'cockpit.html'), { content: banner, kind: 'page' })
  assert.equal(artifactDocumentForUpload('<!doctype html><html><body><p>x</p></body></html>', 'r.html')?.kind, 'report')
  assert.match(artifactDocumentForUpload(COMPONENT, 'Dashboard.tsx')!.content, /data-artifact="react"/)
  for (const [file, lang] of [['analysis.py', 'python'], ['util.ts', 'typescript'], ['main.js', 'javascript'], ['theme.css', 'css']] as const) {
    assert.equal(codeLanguageOf(file), lang)
    const page = artifactDocumentForUpload('print(1)\n', file)!.content
    assert.match(page, new RegExp(`data-lang="${lang}"`))
    const served = compileArtifactPage(page)
    assert.match(served, /__source_view/)
    assert.match(served, /\/vendor\/highlight\.min\.js/)
    if (lang === 'python') assert.ok(hasPythonScript(page) && served.includes('BackstoryArtifact.runPython'), 'python pages use the cancellable worker runtime')
  }
  assert.equal(artifactDocumentForUpload('hello', 'notes.docx'), null)
})

test('in-page TypeScript and library-importing modules compile; plain modules and Python are left to the browser', async () => {
  const { hasPythonScript } = await import('../runtime')
  const ts = compileArtifactPage('<html><body><script type="text/typescript">const n: number = 2; document.title = String(n)</script></body></html>')
  assert.ok(!/: number/.test(ts))
  const mod = compileArtifactPage('<html><body><script type="module">import * as d3 from "d3"; const x = await Promise.resolve(d3.sum([1]))</script></body></html>')
  assert.match(mod, /\/vendor\/d3\.min\.js/)
  assert.match(mod, /async function/)
  const plain = '<html><body><script type="module">const x = 1</script></body></html>'
  assert.equal(compileArtifactPage(plain), plain)
  const py = compileArtifactPage('<html><body><script type="text/python">print(1)</script></body></html>')
  assert.ok(hasPythonScript('<script type="text/python">print(1)</script>'))
  assert.match(py, /text\/x-artifact-python/)
  assert.match(py, /BackstoryArtifact\.runPython/)
  assert.doesNotMatch(py, /loadPyodide|src="\/vendor\/pyodide\/pyodide.js"/)
  assert.match(py, /Cancel Python/)
})
