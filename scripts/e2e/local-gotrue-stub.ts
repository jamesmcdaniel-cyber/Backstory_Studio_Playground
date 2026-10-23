/**
 * A LOCAL-ONLY stand-in for Supabase Auth (GoTrue), so the authenticated
 * browser journeys — and the provisioning script — can run against a laptop
 * stack with no Supabase project at all.
 *
 *   npx tsx scripts/e2e/local-gotrue-stub.ts            # listens on 127.0.0.1:54329
 *   GOTRUE_STUB_PORT=54400 npx tsx scripts/e2e/local-gotrue-stub.ts
 *
 * Then point the dev server and the suite at it:
 *   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54329  NEXT_PUBLIC_SUPABASE_ANON_KEY=local-anon
 *   E2E_SUPABASE_URL=http://127.0.0.1:54329          E2E_SUPABASE_ANON_KEY=local-anon
 *   SUPABASE_SERVICE_ROLE_KEY=local-service-role     (only the provisioning script needs it)
 *
 * It implements exactly the endpoints this repository calls, and no more:
 *   POST /auth/v1/token?grant_type=password|refresh_token   (the suite's sign-in)
 *   GET  /auth/v1/user                                       (the middleware's getUser)
 *   POST /auth/v1/logout
 *   GET|POST /auth/v1/admin/users, GET|PUT /auth/v1/admin/users/:id   (provisioning)
 *
 * ── Why it is safe to keep in the tree ───────────────────────────────────
 * It binds to 127.0.0.1 only, holds users in memory, and signs tokens with a
 * random per-process secret, so a token it mints is worthless anywhere but in
 * the process that minted it. Nothing in src/ imports it; the app only ever
 * talks to whatever NEXT_PUBLIC_SUPABASE_URL names.
 *
 * User ids are derived from the email (a v4-shaped UUID over its SHA-256), so a
 * restarted stub hands the same person the same `sub` — which is what lets a
 * provisioned `users.supabaseId` row survive a stub restart.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

const PORT = Number(process.env.GOTRUE_STUB_PORT || 54329)
const HOST = '127.0.0.1'
const SERVICE_ROLE_KEY = process.env.GOTRUE_STUB_SERVICE_ROLE_KEY || 'local-service-role'
const SECRET = randomBytes(32)
const ACCESS_TTL_SECONDS = 60 * 60 * 8

interface StubUser {
  id: string
  email: string
  password: string | null
  email_confirmed_at: string | null
  app_metadata: Record<string, unknown>
  user_metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

const users = new Map<string, StubUser>()
const refreshTokens = new Map<string, string>() // token → user id

function idForEmail(email: string): string {
  const hex = createHash('sha256').update(email.toLowerCase()).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

const b64url = (value: Buffer | string) => Buffer.from(value).toString('base64url')

function sign(payload: Record<string, unknown>): string {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify(payload))
  const signature = createHmac('sha256', SECRET).update(`${head}.${body}`).digest()
  return `${head}.${body}.${b64url(signature)}`
}

function verify(token: string): Record<string, unknown> | null {
  const [head, body, signature] = token.split('.')
  if (!head || !body || !signature) return null
  const expected = createHmac('sha256', SECRET).update(`${head}.${body}`).digest()
  const given = Buffer.from(signature, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null
  return payload
}

function publicUser(user: StubUser) {
  const { password, ...rest } = user
  void password
  return {
    ...rest,
    aud: 'authenticated',
    role: 'authenticated',
    identities: [],
    factors: [],
    confirmed_at: user.email_confirmed_at,
    last_sign_in_at: new Date().toISOString(),
  }
}

function session(user: StubUser) {
  const now = Math.floor(Date.now() / 1000)
  const expiresAt = now + ACCESS_TTL_SECONDS
  const accessToken = sign({
    sub: user.id,
    email: user.email,
    aud: 'authenticated',
    role: 'authenticated',
    aal: 'aal1',
    amr: [{ method: 'password', timestamp: now }],
    app_metadata: user.app_metadata,
    user_metadata: user.user_metadata,
    session_id: randomBytes(8).toString('hex'),
    iat: now,
    exp: expiresAt,
  })
  const refreshToken = randomBytes(24).toString('base64url')
  refreshTokens.set(refreshToken, user.id)
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'bearer',
    expires_in: ACCESS_TTL_SECONDS,
    expires_at: expiresAt,
    user: publicUser(user),
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return {}
  }
}

function send(request: IncomingMessage, response: ServerResponse, status: number, body?: unknown): void {
  // The browser-side Supabase client calls this origin too (session refresh),
  // so answer CORS rather than leave the console full of noise.
  response.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': request.headers.origin || '*',
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info, x-supabase-api-version',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  })
  response.end(body === undefined ? '' : JSON.stringify(body))
}

function bearer(request: IncomingMessage): string | null {
  const header = request.headers.authorization || ''
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null
}

function upsertUser(input: Record<string, unknown>, existing?: StubUser): StubUser {
  const now = new Date().toISOString()
  const email = String(input.email ?? existing?.email ?? '').trim().toLowerCase()
  const user: StubUser = existing ?? {
    id: idForEmail(email),
    email,
    password: null,
    email_confirmed_at: null,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    created_at: now,
    updated_at: now,
  }
  if (typeof input.password === 'string') user.password = input.password
  if (input.email_confirm === true && !user.email_confirmed_at) user.email_confirmed_at = now
  if (input.app_metadata && typeof input.app_metadata === 'object') user.app_metadata = { ...user.app_metadata, ...(input.app_metadata as object) }
  if (input.user_metadata && typeof input.user_metadata === 'object') user.user_metadata = { ...user.user_metadata, ...(input.user_metadata as object) }
  user.updated_at = now
  users.set(user.id, user)
  return user
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${HOST}:${PORT}`)
  const path = url.pathname.replace(/\/+$/, '')
  if (request.method === 'OPTIONS') return send(request, response, 204)

  if (path === '/auth/v1/token' && request.method === 'POST') {
    const body = await readJson(request)
    const grant = url.searchParams.get('grant_type')
    if (grant === 'password') {
      const email = String(body.email ?? '').trim().toLowerCase()
      const user = [...users.values()].find((candidate) => candidate.email === email)
      const ok = user && user.password !== null && typeof body.password === 'string' && body.password === user.password
      if (!ok) return send(request, response, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' })
      if (!user.email_confirmed_at) return send(request, response, 400, { error: 'invalid_grant', error_description: 'Email not confirmed' })
      return send(request, response, 200, session(user))
    }
    if (grant === 'refresh_token') {
      const userId = refreshTokens.get(String(body.refresh_token ?? ''))
      const user = userId ? users.get(userId) : undefined
      if (!user) return send(request, response, 400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' })
      return send(request, response, 200, session(user))
    }
    return send(request, response, 400, { error: 'unsupported_grant_type' })
  }

  if (path === '/auth/v1/user' && request.method === 'GET') {
    const token = bearer(request)
    const claims = token ? verify(token) : null
    const user = claims ? users.get(String(claims.sub)) : undefined
    if (!user) return send(request, response, 401, { code: 401, msg: 'invalid JWT' })
    return send(request, response, 200, publicUser(user))
  }

  if (path === '/auth/v1/logout') return send(request, response, 204)

  if (path.startsWith('/auth/v1/admin/users')) {
    if (bearer(request) !== SERVICE_ROLE_KEY) return send(request, response, 401, { msg: 'service role key required' })
    const id = path.split('/')[5]
    if (!id && request.method === 'GET') {
      return send(request, response, 200, { users: [...users.values()].map(publicUser), aud: 'authenticated' })
    }
    if (!id && request.method === 'POST') {
      const body = await readJson(request)
      const email = String(body.email ?? '').trim().toLowerCase()
      if (!email.includes('@')) return send(request, response, 422, { msg: 'email required' })
      if ([...users.values()].some((user) => user.email === email)) {
        return send(request, response, 422, { msg: 'A user with this email address has already been registered', code: 'email_exists' })
      }
      return send(request, response, 200, publicUser(upsertUser(body)))
    }
    const existing = id ? users.get(id) : undefined
    if (!existing) return send(request, response, 404, { msg: 'User not found' })
    if (request.method === 'GET') return send(request, response, 200, publicUser(existing))
    if (request.method === 'PUT') return send(request, response, 200, publicUser(upsertUser(await readJson(request), existing)))
  }

  if (path === '/auth/v1/health' || path === '/auth/v1/settings') {
    return send(request, response, 200, { name: 'local-gotrue-stub', external: { email: true }, disable_signup: true })
  }

  return send(request, response, 404, { msg: `local-gotrue-stub: no route for ${request.method} ${path}` })
})

server.listen(PORT, HOST, () => {
  console.log(`local-gotrue-stub listening on http://${HOST}:${PORT} (service role key: ${SERVICE_ROLE_KEY})`)
})
