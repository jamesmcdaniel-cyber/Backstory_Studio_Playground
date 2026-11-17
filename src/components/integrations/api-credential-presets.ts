/**
 * The plain-language presets behind "Connect an API".
 *
 * The full HTTP credential form speaks in auth-scheme names (Header Auth, Query
 * Auth, OAuth2 API…), which is precise and also the reason people stall on it:
 * they hold "an API key", "a JWT" or "a client ID and secret", not a scheme.
 * Each preset here maps what someone actually has onto one ordinary
 * HttpCredential — same encryption, owner, host binding, live verification,
 * rotation and revocation as any other — so this is a front door, not a second
 * credential store.
 *
 * Pure: the dialog renders the fields, this decides what is saved. That keeps
 * the mapping unit-testable without a browser.
 */
import { WAREHOUSE_HOST_SUFFIXES, WAREHOUSE_LABEL, warehouseKindForHost, type WarehouseKind } from '@/lib/warehouse/hosts'

export type ApiCredentialKind = 'api_key' | 'bearer' | 'client_credentials' | 'basic' | 'snowflake' | 'databricks'

export const API_CREDENTIAL_KINDS: { kind: ApiCredentialKind; label: string; description: string }[] = [
  { kind: 'api_key', label: 'API key', description: 'A key the API expects in a header or query parameter' },
  { kind: 'bearer', label: 'Bearer or JWT token', description: 'A token sent as “Authorization: Bearer …”' },
  { kind: 'client_credentials', label: 'Client ID & secret', description: 'Exchanged for a token, or sent as Basic auth' },
  { kind: 'basic', label: 'Username & password', description: 'HTTP Basic authentication' },
  { kind: 'snowflake', label: 'Snowflake', description: 'Programmatic access token or key pair' },
  { kind: 'databricks', label: 'Databricks', description: 'Personal access token or service principal' },
]

export type ApiCredentialDraft = {
  kind: ApiCredentialKind
  name: string
  /** The API's address — a base URL, an endpoint, or a bare host. */
  address: string
  // API key
  keyPlacement: 'header' | 'query'
  keyName: string
  keyValue: string
  // Bearer / JWT, Snowflake PAT, Databricks PAT
  token: string
  // Client ID & secret
  clientMode: 'oauth' | 'basic' | 'headers'
  tokenUrl: string
  clientId: string
  clientSecret: string
  scope: string
  audience: string
  clientIdHeader: string
  clientSecretHeader: string
  // Username & password
  username: string
  password: string
  // Snowflake
  snowflakeMode: 'pat' | 'keypair'
  snowflakeUser: string
  privateKey: string
  passphrase: string
  // Databricks
  databricksMode: 'pat' | 'service_principal'
}

export const EMPTY_API_CREDENTIAL_DRAFT: Omit<ApiCredentialDraft, 'kind'> = {
  name: '',
  address: '',
  keyPlacement: 'header',
  keyName: '',
  keyValue: '',
  token: '',
  clientMode: 'oauth',
  tokenUrl: '',
  clientId: '',
  clientSecret: '',
  scope: '',
  audience: '',
  clientIdHeader: 'X-Client-Id',
  clientSecretHeader: 'X-Client-Secret',
  username: '',
  password: '',
  snowflakeMode: 'pat',
  snowflakeUser: '',
  privateKey: '',
  passphrase: '',
  databricksMode: 'pat',
}

export type ApiCredentialPayload = {
  name: string
  authType: 'header' | 'query' | 'bearer' | 'oauth2' | 'basic' | 'custom' | 'snowflake_pat' | 'snowflake_keypair'
  url: string
  method: 'GET'
  config: Record<string, string>
}

export type BuildResult = { ok: true; payload: ApiCredentialPayload } | { ok: false; error: string }

const EXAMPLE_ADDRESS: Record<WarehouseKind, string> = {
  snowflake: 'myorg-myaccount.snowflakecomputing.com',
  databricks: 'dbc-a1b2c3d4-e5f6.cloud.databricks.com',
}

/** Placeholder for the address field, by kind. */
export function addressPlaceholder(kind: ApiCredentialKind): string {
  if (kind === 'snowflake' || kind === 'databricks') return EXAMPLE_ADDRESS[kind]
  return 'https://api.example.com/v1'
}

/**
 * Parse what someone typed as the API address. A bare host gets https://;
 * anything that still is not a URL is refused with a sentence, not a stack.
 */
export function parseAddress(input: string): URL | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (!url.hostname.includes('.')) return null
    return url
  } catch {
    return null
  }
}

/** The name a credential gets when nobody typed one. */
export function defaultCredentialName(kind: ApiCredentialKind, address: string): string {
  const host = parseAddress(address)?.hostname ?? ''
  const label = API_CREDENTIAL_KINDS.find((entry) => entry.kind === kind)?.label ?? 'API credential'
  return host ? `${host} · ${label}` : ''
}

const required = (value: string) => value.trim().length > 0

export function buildApiCredentialPayload(draft: ApiCredentialDraft): BuildResult {
  const url = parseAddress(draft.address)
  if (!url) {
    return {
      ok: false,
      error:
        draft.kind === 'snowflake' || draft.kind === 'databricks'
          ? `Enter your ${WAREHOUSE_LABEL[draft.kind]} address, like ${EXAMPLE_ADDRESS[draft.kind]}.`
          : 'Enter the API’s address, like https://api.example.com/v1.',
    }
  }
  const name = draft.name.trim() || defaultCredentialName(draft.kind, draft.address)
  const host = url.hostname.toLowerCase()
  const base = { name, method: 'GET' as const }

  switch (draft.kind) {
    case 'api_key': {
      if (!required(draft.keyName)) {
        return { ok: false, error: draft.keyPlacement === 'header' ? 'Enter the header name the API reads the key from, like X-API-Key.' : 'Enter the query parameter the API reads the key from, like api_key.' }
      }
      if (!required(draft.keyValue)) return { ok: false, error: 'Paste the API key.' }
      return {
        ok: true,
        payload: { ...base, authType: draft.keyPlacement, url: url.toString(), config: { name: draft.keyName.trim(), value: draft.keyValue.trim() } },
      }
    }
    case 'bearer': {
      const token = stripBearer(draft.token)
      if (!token) return { ok: false, error: 'Paste the token.' }
      return { ok: true, payload: { ...base, authType: 'bearer', url: url.toString(), config: { token } } }
    }
    case 'basic': {
      if (!required(draft.username)) return { ok: false, error: 'Enter the username.' }
      if (!required(draft.password)) return { ok: false, error: 'Enter the password.' }
      return { ok: true, payload: { ...base, authType: 'basic', url: url.toString(), config: { username: draft.username.trim(), password: draft.password } } }
    }
    case 'client_credentials':
      return clientCredentialsPayload(draft, url, base)
    case 'snowflake':
      return snowflakePayload(draft, host, base)
    case 'databricks':
      return databricksPayload(draft, host, base)
  }
}

/** People paste "Bearer eyJ…" as often as "eyJ…"; the scheme is added on send. */
function stripBearer(token: string): string {
  return token.trim().replace(/^bearer\s+/i, '').trim()
}

function clientCredentialsPayload(draft: ApiCredentialDraft, url: URL, base: { name: string; method: 'GET' }): BuildResult {
  if (!required(draft.clientId)) return { ok: false, error: 'Enter the client ID.' }
  if (!required(draft.clientSecret)) return { ok: false, error: 'Enter the client secret.' }
  const clientId = draft.clientId.trim()
  const clientSecret = draft.clientSecret.trim()

  if (draft.clientMode === 'basic') {
    return { ok: true, payload: { ...base, authType: 'basic', url: url.toString(), config: { username: clientId, password: clientSecret } } }
  }
  if (draft.clientMode === 'headers') {
    if (!required(draft.clientIdHeader) || !required(draft.clientSecretHeader)) {
      return { ok: false, error: 'Enter both header names the API reads the client ID and secret from.' }
    }
    return {
      ok: true,
      payload: {
        ...base,
        authType: 'custom',
        url: url.toString(),
        config: { headersJson: JSON.stringify({ [draft.clientIdHeader.trim()]: clientId, [draft.clientSecretHeader.trim()]: clientSecret }) },
      },
    }
  }
  const tokenUrl = parseAddress(draft.tokenUrl)
  if (!tokenUrl) return { ok: false, error: 'Enter the token URL the client ID and secret are exchanged at, like https://auth.example.com/oauth/token.' }
  return {
    ok: true,
    payload: {
      ...base,
      authType: 'oauth2',
      url: url.toString(),
      config: {
        tokenUrl: tokenUrl.toString(),
        clientId,
        clientSecret,
        ...(required(draft.scope) ? { scope: draft.scope.trim() } : {}),
        ...(required(draft.audience) ? { audience: draft.audience.trim() } : {}),
      },
    },
  }
}

function warehouseHostError(kind: WarehouseKind, host: string): string | null {
  if (warehouseKindForHost(host) === kind) return null
  return `That isn’t a ${WAREHOUSE_LABEL[kind]} address — it should end in ${WAREHOUSE_HOST_SUFFIXES[kind].join(' or ')}, like ${EXAMPLE_ADDRESS[kind]}.`
}

function snowflakePayload(draft: ApiCredentialDraft, host: string, base: { name: string; method: 'GET' }): BuildResult {
  const hostError = warehouseHostError('snowflake', host)
  if (hostError) return { ok: false, error: hostError }
  // The statements endpoint answers 401 to a bad credential, so a saved row is
  // one Snowflake has already accepted once.
  const url = `https://${host}/api/v2/statements`
  if (draft.snowflakeMode === 'pat') {
    const token = stripBearer(draft.token)
    if (!token) return { ok: false, error: 'Paste the Snowflake programmatic access token.' }
    return { ok: true, payload: { ...base, authType: 'snowflake_pat', url, config: { token } } }
  }
  if (!required(draft.snowflakeUser)) return { ok: false, error: 'Enter the Snowflake user the key belongs to.' }
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(draft.privateKey)) {
    return { ok: false, error: 'Paste the private key in PEM form — it starts with -----BEGIN PRIVATE KEY-----.' }
  }
  return {
    ok: true,
    payload: {
      ...base,
      authType: 'snowflake_keypair',
      url,
      // The account identifier is read from the host when signing.
      config: {
        user: draft.snowflakeUser.trim(),
        privateKey: draft.privateKey.trim(),
        ...(required(draft.passphrase) ? { passphrase: draft.passphrase } : {}),
      },
    },
  }
}

function databricksPayload(draft: ApiCredentialDraft, host: string, base: { name: string; method: 'GET' }): BuildResult {
  const hostError = warehouseHostError('databricks', host)
  if (hostError) return { ok: false, error: hostError }
  // "Who am I" — 401 without a valid token, readable by every identity.
  const url = `https://${host}/api/2.0/preview/scim/v2/Me`
  if (draft.databricksMode === 'pat') {
    const token = stripBearer(draft.token)
    if (!token) return { ok: false, error: 'Paste the Databricks personal access token.' }
    return { ok: true, payload: { ...base, authType: 'bearer', url, config: { token } } }
  }
  if (!required(draft.clientId)) return { ok: false, error: 'Enter the service principal’s client ID.' }
  if (!required(draft.clientSecret)) return { ok: false, error: 'Enter the service principal’s OAuth secret.' }
  return {
    ok: true,
    payload: {
      ...base,
      authType: 'oauth2',
      url,
      // Databricks machine-to-machine OAuth: the workspace's own token endpoint.
      config: { tokenUrl: `https://${host}/oidc/v1/token`, clientId: draft.clientId.trim(), clientSecret: draft.clientSecret.trim(), scope: 'all-apis' },
    },
  }
}
