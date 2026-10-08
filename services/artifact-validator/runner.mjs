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
  let origin, browser
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    res.setHeader('Access-Control-Allow-Origin', '*')
    if (path === '/') {
      res.setHeader('Content-Type', 'text/html')
      return res.end(`<!doctype html><body><script>const states=new Map();window.validationInteractions=false;addEventListener('message',e=>{if(e.source!==document.querySelector('iframe').contentWindow||e.origin!=='null')return;const m=e.data;if(m?.type==='backstory:state'){const old=states.get(m.payload.key)||{value:null,revision:0};let result=old,error;if(m.op==='set'){if(!window.validationInteractions)error='Do not write state automatically on startup.';else if(m.payload.revision!==old.revision)error='State revision conflict';else{result={value:m.payload.value,revision:old.revision+1};states.set(m.payload.key,result)}}e.source.postMessage({type:'backstory:state-result',id:m.id,result,error},'*')}})</script><iframe title="Candidate" sandbox="allow-scripts allow-forms allow-modals allow-downloads" src="/artifact"></iframe></body>`)
    }
    if (path === '/artifact') {
      res.setHeader('Content-Type', 'text/html')
      // Match the viewer's DOM submit events. form-action still forbids actual
      // submissions; the opaque origin and isolated network remain unchanged.
      res.setHeader('Content-Security-Policy', `sandbox allow-scripts allow-forms allow-modals allow-downloads; default-src 'none'; base-uri 'none'; form-action 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; worker-src 'self' blob:; connect-src ${origin}/vendor/pyodide/`)
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
    browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: ['--disable-dev-shm-usage'], timeout: 15000 })
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
    const checks = ['sandboxed-browser-startup', 'runtime-assets', 'uncaught-errors', 'visible-content']
    const steps = await frame.evaluate(() => window.__artifactTests ?? [])
    if (!Array.isArray(steps) || steps.length > 20) throw new Error('__artifactTests must contain at most 20 declarative interaction steps')
    const controls = await frame.locator('button,input,select,textarea,[role="button"]').count()
    if (controls && !steps.length) record('Interactive artifacts must declare window.__artifactTests with an action and observable assertion for their primary workflow.')
    await page.evaluate(() => { window.validationInteractions = true })
    let actions = 0, assertions = 0
    for (const [index, step] of steps.entries()) {
      if (!step || typeof step.selector !== 'string' || step.selector.length > 300) throw new Error('Each artifact test needs a bounded selector')
      const target = frame.locator(step.selector)
      try { switch (step.action) {
        case 'click': await target.click({ timeout: 2000 }); actions++; break
        case 'fill': if (typeof step.value !== 'string' || step.value.length > 1000) throw new Error('Invalid test fill value'); await target.fill(step.value, { timeout: 2000 }); actions++; break
        case 'select': await target.selectOption(String(step.value).slice(0, 1000), { timeout: 2000 }); actions++; break
        case 'expectText':
          if (typeof step.value !== 'string' || !step.value.length) throw new Error('expectText requires non-empty expected text')
          await frame.waitForFunction(({ selector, value }) => document.querySelector(selector)?.textContent?.includes(value), step, { timeout: 15000 }); assertions++; break
        case 'expectValue':
          await frame.waitForFunction(({ selector, value }) => document.querySelector(selector)?.value === value, step, { timeout: 15000 }); assertions++; break
        default: throw new Error('Unsupported artifact test action: ' + step.action)
      } } catch (error) { throw new Error(`Artifact check ${index + 1} (${step.action} ${step.selector}) failed: ${error.message}`) }
    }
    if (steps.length && (!actions || !assertions)) record('Artifact tests need both an action and an observable assertion')
    if (actions && assertions) checks.push('declared-primary-workflow')
    // Test the real SDK/bridge protocol using synthetic data only, then reload
    // the frame to prove the parent-held state survives a source reload.
    const saved = await frame.evaluate(async () => { const sdk = window.BackstoryArtifact; if (!sdk) return false; await sdk.saveState('validator-probe', { sentinel: 42 }, 0); return (await sdk.loadState('validator-probe')).value.sentinel === 42 })
    if (!saved) record('Artifact saved-state bridge round-trip failed')
    else {
      await frame.goto(origin + '/artifact', { waitUntil: 'load', timeout: 10000 })
      const persisted = await frame.evaluate(async () => (await window.BackstoryArtifact.loadState('validator-probe')).value.sentinel === 42)
      if (!persisted) record('Artifact saved state disappeared after reload')
      else checks.push('synthetic-state-save-and-reload')
    }
    for (const message of await frame.locator('#__artifact_error,[data-backstory-runtime-error]').allTextContents()) record(message)
    // A 1280×800 picture of the page as it passed, for cards and for the
    // assistant to look at. Taken after the checks so a failed page has none.
    let screenshot
    if (!errors.length) {
      try {
        await page.setViewportSize({ width: 1280, height: 800 })
        await page.evaluate(() => { const f = document.querySelector('iframe'); f.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:800px;border:0;margin:0' })
        await page.waitForTimeout(300)
        screenshot = (await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1280, height: 800 }, timeout: 5000 })).toString('base64')
      } catch { screenshot = undefined }
    }
    process.send({ ok: !errors.length, errors, checks, ...(screenshot ? { screenshot } : {}), limits: 'Tests cover declared workflows and synthetic storage, not arbitrary business rules or real integration side effects.' })
  } catch (error) { record(error.message); process.send({ ok: false, errors }) }
  finally { await browser?.close().catch(() => {}); server.close(); process.disconnect() }
})
