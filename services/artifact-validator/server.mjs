import http from 'node:http'
import { fork } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { mkdtemp, chown, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const token = process.env.ARTIFACT_VALIDATOR_TOKEN
if (!token || token.length < 32) throw new Error('Validator authentication is required')
const digest = value => createHash('sha256').update(value).digest()
let busy = false, nextUid = 1001
const reply = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }

http.createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') return reply(res, 200, { status: 'ok', busy, isolation: 'unique-uid-network-namespace', chromiumSandbox: true })
  if (req.url !== '/validate' || req.method !== 'POST') return reply(res, 404, { error: 'Not found' })
  if (!timingSafeEqual(digest(req.headers.authorization || ''), digest(`Bearer ${token}`))) return reply(res, 401, { error: 'Unauthorized' })
  if (busy) return reply(res, 429, { error: 'Validator busy; retry shortly' })
  busy = true
  let child, directory, timer
  const started = Date.now()
  try {
    const chunks = []; let size = 0
    req.setTimeout(5000, () => req.destroy())
    for await (const chunk of req) { size += chunk.length; if (size > 8_000_000) throw new Error('Payload too large'); chunks.push(chunk) }
    req.setTimeout(0)
    const input = JSON.parse(Buffer.concat(chunks).toString())
    if (typeof input.html !== 'string' || !input.html.trim()) throw new Error('HTML is required')
    if (nextUid >= 65534) throw new Error('Validator must restart before UID reuse')
    const uid = nextUid++
    directory = await mkdtemp(join(tmpdir(), 'artifact-validation-'))
    await chown(directory, uid, uid)
    child = fork(new URL('./runner.mjs', import.meta.url), [], {
      execPath: '/usr/bin/unshare', execArgv: ['--net', '--mount', '--', '/app/run-isolated.sh', String(uid)], detached: true, cwd: directory,
      // No inherited app/validator credentials, provider keys, or Fly metadata.
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: directory, TMPDIR: directory, PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-1500) })
    const result = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Artifact startup exceeded the 30 second deadline')), 30_000)
      child.once('message', resolve)
      child.once('error', reject)
      child.once('exit', () => reject(new Error('Browser validator exited before reporting a result. ' + stderr)))
      child.send({ html: input.html })
    })
    reply(res, 200, { ...result, elapsedMs: Date.now() - started })
  } catch (error) {
    reply(res, 422, { ok: false, errors: [String(error.message || 'Validation failed').slice(0, 500)], elapsedMs: Date.now() - started })
  } finally {
    clearTimeout(timer)
    if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
    if (directory) await rm(directory, { recursive: true, force: true })
    busy = false
  }
}).listen(8080, '0.0.0.0')
