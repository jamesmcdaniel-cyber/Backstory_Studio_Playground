/**
 * OAuth 2.0 authorization-code flow helpers for the Backstory MCP.
 *
 * Pure functions only — no DB access, no Next.js request objects. These power
 * the /api/mcp-connections/oauth/{start,callback} route handlers and the
 * McpClient token-refresh path.
 *
 * The Backstory MCP advertises:
 *   - Dynamic Client Registration (DCR) at registration_endpoint
 *   - PKCE with S256 only (code_challenge_methods_supported: ["S256"])
 *   - grant_types: authorization_code + refresh_token (NOT client_credentials)
 *   - scope: "claudeai"
 *
 * SECURITY: never include tokens/secrets in thrown error messages.
 */

import crypto from 'crypto'

/**
 * Cookie carrying the in-flight OAuth state between /oauth/start and
 * /oauth/callback. Lives here (not in a route file) because Next.js route
 * modules may only export HTTP handlers and route config fields.
 */
export const OAUTH_COOKIE = 'bmcp_oauth'

// ---------------------------------------------------------------------------
// Redirect safety
// ---------------------------------------------------------------------------

/**
 * Accept only same-origin path redirects: must start with exactly one '/',
 * and never contain a backslash (WHATWG URL normalizes '\' to '/' for http(s),
 * so '/\evil.com' would resolve off-origin — CWE-601). Also rejects control
 * characters and whitespace, which WHATWG strips during parsing and could
 * smuggle a protocol-relative redirect.
 */
export function safeReturnToPath(value: string | undefined | null): string | undefined {
  if (!value) return undefined
  if (value.includes('\\')) return undefined
  // WHATWG URL strips C0 controls/DEL during parsing, so any of them could
  // smuggle a protocol-relative redirect ('/\t/evil.com' -> '//evil.com').
  // Also reject space and other whitespace which can't appear in valid paths.
  if (/[\x00-\x20\x7F]/.test(value)) return undefined
  if (!/^\/(?!\/)/.test(value)) return undefined
  return value
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface AuthServerMetadata {
  issuer?: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  scopes_supported?: string[]
  code_challenge_methods_supported?: string[]
  grant_types_supported?: string[]
  token_endpoint_auth_methods_supported?: string[]
}

/**
 * GET ${origin}/.well-known/oauth-authorization-server for the given MCP
 * server URL and return the parsed metadata.
 */
export async function discoverAuthServer(
  serverUrl: string,
): Promise<AuthServerMetadata> {
  const origin = new URL(serverUrl).origin
  const discoveryUrl = `${origin}/.well-known/oauth-authorization-server`

  const response = await fetch(discoveryUrl, {
    headers: { Accept: 'application/json' },
    redirect: 'error', // don't follow a 3xx to an internal host (SSRF guard)
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    throw new Error(
      `OAuth discovery failed for ${origin} (status ${response.status})`,
    )
  }

  const meta = (await response.json()) as AuthServerMetadata
  if (!meta.authorization_endpoint || !meta.token_endpoint) {
    throw new Error(
      'OAuth discovery metadata is missing authorization_endpoint or token_endpoint',
    )
  }
  return meta
}

// ---------------------------------------------------------------------------
// PKCE (S256)
// ---------------------------------------------------------------------------

function base64url(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export interface Pkce {
  verifier: string
  challenge: string
}

/**
 * Generate a PKCE verifier/challenge pair.
 *   verifier  = base64url(32 random bytes)
 *   challenge = base64url(sha256(verifier))
 */
export function generatePkce(): Pkce {
  const verifier = base64url(crypto.randomBytes(32))
  const challenge = base64url(
    crypto.createHash('sha256').update(verifier).digest(),
  )
  return { verifier, challenge }
}

/** Cryptographically-random `state` value for CSRF protection. */
export function generateState(): string {
  return base64url(crypto.randomBytes(32))
}

// ---------------------------------------------------------------------------
// Dynamic Client Registration (DCR)
// ---------------------------------------------------------------------------

export interface RegisteredClient {
  client_id: string
  client_secret?: string
}

/**
 * POST to the registration_endpoint to dynamically register a client for this
 * redirect URI. Returns the issued client_id (and client_secret if the server
 * issues one — a public client may not).
 */
export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<RegisteredClient> {
  const response = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_name: 'Backstory Studio',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'claudeai',
    }),
    redirect: 'error', // don't follow a 3xx to an internal host (SSRF guard)
    signal: AbortSignal.timeout(15_000),
  })

  if (!response.ok) {
    // Never echo the response body — it may carry sensitive detail.
    throw new Error(
      `Dynamic client registration failed (status ${response.status})`,
    )
  }

  const data = (await response.json()) as RegisteredClient
  if (!data.client_id) {
    throw new Error(
      'Dynamic client registration response did not include client_id',
    )
  }
  return { client_id: data.client_id, client_secret: data.client_secret }
}

// ---------------------------------------------------------------------------
// Authorization URL
// ---------------------------------------------------------------------------

export interface BuildAuthorizeUrlParams {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
  scope: string
}

/** Build the authorize URL the browser should be redirected to. */
export function buildAuthorizeUrl(
  authorizationEndpoint: string,
  { clientId, redirectUri, state, codeChallenge, scope }: BuildAuthorizeUrlParams,
): string {
  const url = new URL(authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('scope', scope)
  return url.toString()
}

// ---------------------------------------------------------------------------
// Token responses
// ---------------------------------------------------------------------------

export interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
}

interface RawTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
}

/**
 * Build the auth headers + extra body params for confidential vs public
 * clients. If a client_secret is present we send it BOTH in the body
 * (client_secret_post) and as HTTP Basic (client_secret_basic) since the
 * Backstory token endpoint advertises both styles. Public clients (DCR with
 * token_endpoint_auth_method=none) send neither.
 */
function clientAuth(
  clientId: string,
  clientSecret: string | undefined,
): { headers: Record<string, string>; bodyExtra: Record<string, string> } {
  if (clientSecret) {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
    return {
      headers: { Authorization: `Basic ${basic}` },
      bodyExtra: { client_secret: clientSecret },
    }
  }
  return { headers: {}, bodyExtra: {} }
}

// ---------------------------------------------------------------------------
// Authorization-code exchange
// ---------------------------------------------------------------------------

export interface ExchangeCodeParams {
  code: string
  redirectUri: string
  clientId: string
  clientSecret?: string
  codeVerifier: string
}

/** Exchange an authorization code (+ PKCE verifier) for tokens. */
export async function exchangeCode(
  tokenEndpoint: string,
  { code, redirectUri, clientId, clientSecret, codeVerifier }: ExchangeCodeParams,
): Promise<TokenResponse> {
  const { headers, bodyExtra } = clientAuth(clientId, clientSecret)

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
    ...bodyExtra,
  })

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      ...headers,
    },
    body: body.toString(),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })

  if (!response.ok) {
    throw new Error(`Token exchange failed (status ${response.status})`)
  }

  const data = (await response.json()) as RawTokenResponse
  if (!data.access_token) {
    throw new Error('Token exchange response did not include access_token')
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
  }
}

// ---------------------------------------------------------------------------
// Refresh-token exchange
// ---------------------------------------------------------------------------

export interface RefreshTokenParams {
  clientId: string
  clientSecret?: string
  refreshToken: string
}

/**
 * Exchange a refresh_token for a new access_token. If the server rotates the
 * refresh_token it is returned in `refresh_token`; otherwise the caller should
 * keep reusing the old one.
 */
export async function refreshAccessToken(
  tokenEndpoint: string,
  { clientId, clientSecret, refreshToken }: RefreshTokenParams,
): Promise<TokenResponse> {
  const { headers, bodyExtra } = clientAuth(clientId, clientSecret)

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    ...bodyExtra,
  })

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      ...headers,
    },
    body: body.toString(),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })

  if (!response.ok) {
    throw new Error(`Token refresh failed (status ${response.status})`)
  }

  const data = (await response.json()) as RawTokenResponse
  if (!data.access_token) {
    throw new Error('Token refresh response did not include access_token')
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
  }
}
