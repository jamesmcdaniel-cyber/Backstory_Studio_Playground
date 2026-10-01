import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { chromium } from 'playwright'

// Runs in a fresh UID/process/browser with no credentials. Only this trusted
// harness uses Playwright; artifact source is never evaluated in Node.
process.once('message', async ({ html }) => {
  const errors = []
  const record = message => { if (errors.length < 8) errors.push(String(message).slice(0, 500)) }
  const mime = { '.js': 'application/javascript', '.mjs': 'application/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css', '.zip': 'application/zip', '.whl': 'application/octet-stream' }
  let origin
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    res.setHeader('Access-Control-Allow-Origin', '*')
    if (path === '/') {
      res.setHeader('Content-Type', 'text/html')
      return res.end(`<!doctype html><body><script>addEventListener('message',e=>{if(e.source!==document.querySelector('iframe').contentWindow||e.origin!=='null')return;const m=e.data;if(m?.type==='backstory:state'){e.source.postMessage({type:'backstory:state-result',id:m.id,...(m.op==='get'?{result:{value:null,revision:0}}:{error:'Preflight is read-only. Do not write state automatically on startup.'})},'*')}})</script><iframe title="Candidate" sandbox="allow-scripts allow-modals allow-downloads" src="/artifact"></iframe></body>`)
    }
    if (path === '/artifact') {
      res.setHeader('Content-Type', 'text/html')
      res.setHeader('Content-Security-Policy', `sandbox allow-scripts allow-modals allow-downloads; default-src 'none'; base-uri 'none'; form-action 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; worker-src 'self' blob:; connect-src ${origin}/vendor/pyodide/`)
      return res.end(html.replaceAll('http://artifact-runtime.invalid', origin))
    }
    if (path.startsWith('/vendor/')) {
      const target = resolve('/app/public', `.${decodeURIComponent(path)}`)
      if (target.startsWith('/app/public/vendor/')) {
        try { const bytes = await readFile(target); res.setHeader('Content-Type', mime[extname(target)] || 'application/octet-stream'); return res.end(bytes) } catch {}
      }
    }
    res.writeHead(404); res.end()
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${server.address().port}`
    const browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: ['--disable-dev-shm-usage'], timeout: 15000 })
    // The opaque sandbox already forbids service workers. Playwright's block
    // shim accesses navigator.serviceWorker and itself throws in this frame.
    const context = await browser.newContext({ acceptDownloads: false })
    await context.route('**/*', route => {
      const url = route.request().url()
      if (url.startsWith(origin + '/') || /^(data|blob):/.test(url)) return route.continue()
      return route.abort()
    })
    const page = await context.newPage()
    page.on('pageerror', error => record(error.message))
    page.on('dialog', dialog => { record('Unexpected startup dialog'); void dialog.dismiss() })
    page.on('response', response => { if (response.status() >= 400 && response.url().startsWith(origin + '/vendor/')) record('Required runtime asset did not load: ' + new URL(response.url()).pathname) })
    await page.goto(origin, { waitUntil: 'load', timeout: 10000 })
    await page.waitForTimeout(1500)
    const frame = page.frames().find(f => f.url() === origin + '/artifact')
    if (!frame) throw new Error('Artifact frame failed to load')
    await frame.waitForFunction(() => window.__artifactPythonStartupState !== 'running', null, { timeout: 20000 })
    const text = await frame.locator('body').innerText({ timeout: 2000 })
    if (!text.trim() && !await frame.locator('canvas,svg,img').count()) record('Artifact rendered no visible content')
    for (const message of await frame.locator('#__artifact_error,[data-backstory-runtime-error]').allTextContents()) record(message)
    process.send({ ok: !errors.length, errors, checks: ['sandboxed-browser-startup', 'runtime-assets', 'uncaught-errors', 'visible-content'], limits: 'Startup smoke check only; not proof of every interaction or business rule.' })
    await browser.close()
  } catch (error) { record(error.message); process.send({ ok: false, errors }) }
  finally { server.close(); process.disconnect() }
})
