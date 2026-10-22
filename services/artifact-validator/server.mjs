import http from 'node:http'
import { fork, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, timingSafeEqual } from 'node:crypto'
import { mkdtemp, chown, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { admission } from './admission.mjs'

const token = process.env.ARTIFACT_VALIDATOR_TOKEN
if (!token || token.length < 32) throw new Error('Validator authentication is required')
const digest = value => createHash('sha256').update(value).digest()
let nextUid = 1001
const queue = admission()
// The served page, JSON-encoded. Same value as VALIDATOR_MAX_BODY_BYTES in
// src/lib/artifacts/preflight.ts: the largest page the app's size limits allow
// (an 8M-character ROI dashboard), every character escaped to six bytes, plus
// the runtime it is served with. The app measures and refuses larger pages.
const MAX_BODY_BYTES = 67108864
/**
 * A failure of this service, not a verdict on the page: its deadline, a
 * browser that crashed or never started, its UID pool, a request it could not
 * read. Answered as 5xx (or 413/400) with `infra: true`, never as the 422 a
 * page that failed gets, so the app retries instead of "fixing" healthy content.
 */
class InfraError extends Error { constructor(message, status = 503) { super(message); this.status = status } }
const reply = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }

http.createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') return reply(res, 200, { status: 'ok', ...queue.stats(), isolation: 'unique-uid-network-namespace', chromiumSandbox: true })
  if (req.url !== '/validate' || req.method !== 'POST') return reply(res, 404, { error: 'Not found' })
  if (!timingSafeEqual(digest(req.headers.authorization || ''), digest(`Bearer ${token}`))) return reply(res, 401, { error: 'Unauthorized' })
  const cancelled = new AbortController()
  res.once('close', () => cancelled.abort())
  let release
  try { release = await queue.acquire(cancelled.signal) }
  catch (error) { if (!res.destroyed) { res.setHeader('Retry-After', '3'); reply(res, 429, { errors: [error.message] }) } return }
  let child, directory, timer, uid
  const started = Date.now()
  try {
    const chunks = []; let size = 0
    req.setTimeout(5000, () => req.destroy())
    for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY_BYTES) throw new InfraError('Payload too large', 413); chunks.push(chunk) }
    req.setTimeout(0)
    let input
    try { input = JSON.parse(Buffer.concat(chunks).toString()) } catch { throw new InfraError('Request body is not JSON', 400) }
    if (typeof input.html !== 'string' || !input.html.trim()) throw new InfraError('HTML is required', 400)
    if (nextUid >= 65534) throw new InfraError('Validator must restart before UID reuse')
    uid = nextUid++
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
      timer = setTimeout(() => reject(new InfraError('Artifact validation exceeded the 45 second deadline')), 45_000)
      child.once('message', resolve)
      child.once('error', error => reject(new InfraError(`Browser validator failed to start: ${error.message}`)))
      child.once('exit', () => reject(new InfraError('Browser validator exited before reporting a result. ' + stderr)))
      // Only an agent-authored artifact must declare its interaction tests; an
      // upload or a code page is checked for startup alone. Absent (an older
      // app), the requirement holds, as it always did.
      child.send({ html: input.html, requireDeclaredTests: input.requireDeclaredTests !== false })
    })
    // The runner marks its own startup failures (browser launch, the harness
    // page or frame never loading) as infra: the service, not the page.
    reply(res, result?.infra ? 503 : 200, { ...result, elapsedMs: Date.now() - started })
  } catch (error) {
    reply(res, error instanceof InfraError ? error.status : 503, { ok: false, infra: true, errors: [String(error.message || 'Validation failed').slice(0, 500)], elapsedMs: Date.now() - started })
  } finally {
    clearTimeout(timer)
    if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
    // Chromium may create its own process group. Kill this job's never-reused
    // UID as well, including on timeout/crash; no other job shares the UID.
    if (uid) await promisify(execFile)('/usr/bin/pkill', ['-KILL', '-u', String(uid)], { timeout: 5000 }).catch(() => {})
    if (directory) await rm(directory, { recursive: true, force: true })
    release()
  }
}).listen(8080, '0.0.0.0')
