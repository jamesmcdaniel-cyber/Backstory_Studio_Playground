import { createHash, createHmac, randomBytes } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { decryptSecret, encryptSecret } from '@/lib/crypto/secrets'
import { ensureFreshConnectionToken } from '@/lib/mcp/connection-token'
import { mcpConfigFromConnection } from '@/lib/mcp/mcp-client'
import { mcpConnectionScope } from '@/lib/flows/tool-catalog'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import { assertPublicUrl } from '@/lib/net/ssrf'

export const HTTP_AUTH_TYPES = [
  'basic',
  'bearer',
  'custom',
  'digest',
  'header',
  'oauth1',
  'oauth2',
  'query',
] as const

export type HttpAuthType = (typeof HTTP_AUTH_TYPES)[number]
export type HttpCredentialConfig = Record<string, string>

export type ResolvedHttpCredential = {
  id?: string
  name?: string
  authType: HttpAuthType
  allowedHost: string
  config: HttpCredentialConfig
}

const oauthTokenCache = new Map<string, { token: string; expiresAt: number }>()

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries())
}

function encode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function parseObject(value: string | undefined, label: string): Record<string, string> {
  if (!value?.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`${label} must be valid JSON.`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`)
  }
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>)
      .filter(([key, item]) => key.trim() && item != null)
      .map(([key, item]) => [key, typeof item === 'string' ? item : JSON.stringify(item)]),
  )
}

function addQuery(urlValue: string, values: Record<string, string>) {
  const url = new URL(urlValue)
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value)
  return url.toString()
}

type Oauth2TokenResponse = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error_description?: string
}

async function requestOauth2Token(
  credential: ResolvedHttpCredential,
  cacheKey: string,
  tokenUrl: string,
  form: URLSearchParams,
): Promise<string> {
  await assertPublicUrl(tokenUrl)
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form,
    redirect: 'error',
  })
  const payload = (await response.json().catch(() => ({}))) as Oauth2TokenResponse
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || `OAuth2 token endpoint returned HTTP ${response.status}.`)
  }
  oauthTokenCache.set(cacheKey, {
    token: payload.access_token,
    expiresAt: Date.now() + Math.max(30, Number(payload.expires_in) || 300) * 1000,
  })
  // Refresh-token rotation: some providers return a new refresh token that
  // invalidates the old one. Persist it (best effort) so the next cold start
  // doesn't reuse a dead token. Never throw from this path — the request the
  // caller wanted has already succeeded.
  if (payload.refresh_token && payload.refresh_token !== credential.config.refreshToken && credential.id) {
    credential.config.refreshToken = payload.refresh_token
    try {
      await prisma.httpCredential.update({
        where: { id: credential.id },
        data: { secretConfig: encryptSecret(JSON.stringify(credential.config)) },
      })
    } catch {
      /* keep serving; the in-memory config already carries the new token */
    }
  }
  return payload.access_token
}

async function oauth2Token(credential: ResolvedHttpCredential): Promise<string> {
  const cfg = credential.config
  const cacheKey = credential.id || `${cfg.tokenUrl || ''}:${cfg.clientId || ''}:${cfg.scope || ''}`
  const cached = oauthTokenCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now() + 15_000) return cached.token

  // Refresh-token grant takes priority: its presence means the access token
  // rotates, so a fresh exchange is always safest.
  if (cfg.refreshToken?.trim() && cfg.tokenUrl?.trim()) {
    const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cfg.refreshToken.trim() })
    if (cfg.clientId) form.set('client_id', cfg.clientId)
    if (cfg.clientSecret) form.set('client_secret', cfg.clientSecret)
    if (cfg.scope) form.set('scope', cfg.scope)
    return requestOauth2Token(credential, cacheKey, cfg.tokenUrl.trim(), form)
  }

  if (cfg.accessToken?.trim()) return cfg.accessToken.trim()

  if (!cfg.tokenUrl || !cfg.clientId || !cfg.clientSecret) {
    throw new Error('OAuth2 requires an access token, a refresh token, or client credentials with a token URL.')
  }
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  })
  if (cfg.scope) form.set('scope', cfg.scope)
  if (cfg.audience) form.set('audience', cfg.audience)
  return requestOauth2Token(credential, cacheKey, cfg.tokenUrl, form)
}

function oauth1Header(urlValue: string, method: string, cfg: HttpCredentialConfig) {
  if (!cfg.consumerKey || !cfg.consumerSecret) throw new Error('OAuth1 requires a consumer key and consumer secret.')
  const url = new URL(urlValue)
  const oauth: Record<string, string> = {
    oauth_consumer_key: cfg.consumerKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
  }
  if (cfg.token) oauth.oauth_token = cfg.token
  const params = [
    ...Array.from(url.searchParams.entries()),
    ...Object.entries(oauth),
  ].sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue))
  const parameterString = params.map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&')
  const baseUrl = `${url.protocol}//${url.host}${url.pathname}`
  const base = `${method.toUpperCase()}&${encode(baseUrl)}&${encode(parameterString)}`
  const signingKey = `${encode(cfg.consumerSecret)}&${encode(cfg.tokenSecret || '')}`
  oauth.oauth_signature = createHmac('sha1', signingKey).update(base).digest('base64')
  return `OAuth ${Object.entries(oauth).map(([key, value]) => `${encode(key)}="${encode(value)}"`).join(', ')}`
}

/** Apply every non-Digest credential form before the request is sent. */
export async function applyHttpCredential(
  request: { url: string; init: RequestInit },
  credential: ResolvedHttpCredential,
): Promise<{ url: string; init: RequestInit }> {
  const requestHost = new URL(request.url).hostname.toLowerCase()
  if (requestHost !== credential.allowedHost.toLowerCase()) {
    throw new Error(`Credential "${credential.name || 'HTTP credential'}" is restricted to ${credential.allowedHost}.`)
  }

  const cfg = credential.config
  let url = request.url
  const headers = headerRecord(request.init.headers)
  switch (credential.authType) {
    case 'basic':
      headers.authorization = `Basic ${Buffer.from(`${cfg.username || ''}:${cfg.password || ''}`).toString('base64')}`
      break
    case 'bearer':
      headers.authorization = `Bearer ${cfg.token || ''}`
      break
    case 'header':
      if (!cfg.name) throw new Error('Header authentication requires a header name.')
      headers[cfg.name] = cfg.value || ''
      break
    case 'query':
      if (!cfg.name) throw new Error('Query authentication requires a parameter name.')
      url = addQuery(url, { [cfg.name]: cfg.value || '' })
      break
    case 'custom':
      Object.assign(headers, parseObject(cfg.headersJson, 'Custom authentication headers'))
      url = addQuery(url, parseObject(cfg.queryJson, 'Custom authentication query parameters'))
      break
    case 'oauth1':
      headers.authorization = oauth1Header(url, String(request.init.method || 'GET'), cfg)
      break
    case 'oauth2':
      headers.authorization = `Bearer ${await oauth2Token(credential)}`
      break
    case 'digest':
      // Digest needs the server's nonce from a 401 challenge and is applied by
      // fetchWithHttpCredential below.
      break
  }
  return { url, init: { ...request.init, headers } }
}

function digestParts(challenge: string): Record<string, string> {
  const result: Record<string, string> = {}
  const source = challenge.replace(/^Digest\s+/i, '')
  for (const match of source.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) {
    result[match[1]] = match[2] ?? match[3] ?? ''
  }
  return result
}

function digestHeader(urlValue: string, method: string, cfg: HttpCredentialConfig, challenge: string) {
  const parts = digestParts(challenge)
  if (!parts.realm || !parts.nonce) throw new Error('The server returned an unsupported Digest challenge.')
  const algorithm = (parts.algorithm || 'MD5').toUpperCase()
  if (algorithm !== 'MD5' && algorithm !== 'MD5-SESS') throw new Error(`Digest algorithm ${algorithm} is not supported.`)
  const hash = (value: string) => createHash('md5').update(value).digest('hex')
  const uri = `${new URL(urlValue).pathname}${new URL(urlValue).search}`
  const cnonce = randomBytes(12).toString('hex')
  const nc = '00000001'
  const qop = (parts.qop || '').split(',').map((value) => value.trim()).find((value) => value === 'auth')
  const initialA1 = hash(`${cfg.username || ''}:${parts.realm}:${cfg.password || ''}`)
  const a1 = algorithm === 'MD5-SESS' ? hash(`${initialA1}:${parts.nonce}:${cnonce}`) : initialA1
  const a2 = hash(`${method.toUpperCase()}:${uri}`)
  const response = qop
    ? hash(`${a1}:${parts.nonce}:${nc}:${cnonce}:${qop}:${a2}`)
    : hash(`${a1}:${parts.nonce}:${a2}`)
  const values: Record<string, string> = {
    username: cfg.username || '',
    realm: parts.realm,
    nonce: parts.nonce,
    uri,
    response,
    algorithm,
  }
  if (parts.opaque) values.opaque = parts.opaque
  if (qop) Object.assign(values, { qop, nc, cnonce })
  return `Digest ${Object.entries(values).map(([key, value]) => `${key}="${value}"`).join(', ')}`
}

const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export async function fetchWithHttpCredential(
  request: { url: string; init: RequestInit; followRedirects?: boolean },
  credential: ResolvedHttpCredential | null,
  signal?: AbortSignal,
): Promise<Response> {
  const applied = credential ? await applyHttpCredential(request, credential) : request
  let currentUrl = applied.url
  let currentInit: RequestInit = { ...applied.init, signal }
  let response = await fetch(currentUrl, currentInit)

  // Digest is a 401-challenge round-trip on the FIRST request only.
  if (credential?.authType === 'digest' && response.status === 401) {
    const challenge = response.headers.get('www-authenticate') || ''
    if (/^Digest\s/i.test(challenge)) {
      await response.body?.cancel().catch(() => undefined)
      const headers = headerRecord(currentInit.headers)
      headers.authorization = digestHeader(currentUrl, String(currentInit.method || 'GET'), credential.config, challenge)
      currentInit = { ...currentInit, headers }
      response = await fetch(currentUrl, currentInit)
    }
  }

  if (!request.followRedirects) return response

  // Manual redirect following: every hop is re-checked against the SSRF guard
  // before it is requested, and credentials/cookies are dropped on a
  // cross-origin hop so they can't leak to another host.
  let hops = 0
  while (REDIRECT_STATUSES.has(response.status) && hops < MAX_REDIRECTS) {
    const location = response.headers.get('location')
    if (!location) break
    const nextUrl = new URL(location, currentUrl).toString()
    await assertPublicUrl(nextUrl)
    await response.body?.cancel().catch(() => undefined)

    const crossOrigin = new URL(nextUrl).origin !== new URL(currentUrl).origin
    const headers = headerRecord(currentInit.headers)
    if (crossOrigin) {
      for (const key of Object.keys(headers)) {
        if (/^(authorization|proxy-authorization|cookie)$/i.test(key.trim())) delete headers[key]
      }
    }
    // Per the fetch spec, 303 (and 301/302 on POST) downgrade to GET with no
    // body; 307/308 preserve the method and body.
    let method = String(currentInit.method || 'GET')
    let body = currentInit.body
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method.toUpperCase() === 'POST')) {
      method = 'GET'
      body = undefined
    }
    currentUrl = nextUrl
    currentInit = { ...currentInit, headers, method, body }
    response = await fetch(currentUrl, currentInit)
    hops += 1
  }
  return response
}

export async function resolveHttpCredential(
  credentialId: string,
  organizationId: string,
): Promise<ResolvedHttpCredential> {
  const row = await prisma.httpCredential.findFirst({
    where: { id: credentialId, organizationId, status: 'verified' },
  })
  if (!row) throw new Error('The selected HTTP credential is unavailable. Choose or verify it again.')
  let config: HttpCredentialConfig
  try {
    config = JSON.parse(decryptSecret(row.secretConfig)) as HttpCredentialConfig
  } catch {
    throw new Error('The selected HTTP credential could not be decrypted. Recreate it.')
  }
  return {
    id: row.id,
    name: row.name,
    authType: row.authType as HttpAuthType,
    allowedHost: row.allowedHost,
    config,
  }
}

export function redactedCredential(row: {
  id: string
  name: string
  authType: string
  allowedHost: string
  status: string
  lastVerifiedAt: Date | null
}) {
  return {
    id: row.id,
    name: row.name,
    authType: row.authType,
    allowedHost: row.allowedHost,
    status: row.status,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
  }
}

// Legacy MCP-connection bearer auth remains supported for existing flow
// graphs. New HTTP nodes use credentialId and the generic store above.
export const HTTP_CONNECTION_UNAVAILABLE =
  'The connection for this HTTP step is unavailable — reconnect it in Integrations.'

export function usableConnectionToken(
  config: {
    authType?: string
    flow?: string
    accessToken?: string
    apiKey?: string
    headerName?: string
    expiresAt?: number
  },
  now = Date.now(),
): string | undefined {
  if (config.authType === 'oauth2' && config.flow === 'authcode') {
    if (!config.accessToken) return undefined
    if (typeof config.expiresAt === 'number' && config.expiresAt <= now) return undefined
    return config.accessToken
  }
  if (config.authType === 'api_key' && (!config.headerName?.trim() || config.headerName === 'Authorization')) {
    return config.apiKey || undefined
  }
  return undefined
}

export async function resolveHttpConnectionToken(params: {
  connectionId: string
  organizationId: string
  userId?: string
}): Promise<string> {
  const { plane, ref } = parseFlowToolConnectionId(params.connectionId)
  if (plane !== 'mcp') throw new Error(HTTP_CONNECTION_UNAVAILABLE)

  const connection = await prisma.mcpConnection.findFirst({
    where: { id: ref, ...mcpConnectionScope(params.organizationId, params.userId) },
  })
  if (!connection) throw new Error(HTTP_CONNECTION_UNAVAILABLE)

  const fresh = await ensureFreshConnectionToken(connection)
  const token = usableConnectionToken(mcpConfigFromConnection(fresh))
  if (!token) throw new Error(HTTP_CONNECTION_UNAVAILABLE)
  return token
}
