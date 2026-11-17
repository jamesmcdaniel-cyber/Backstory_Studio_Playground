import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  EMPTY_API_CREDENTIAL_DRAFT,
  buildApiCredentialPayload,
  parseAddress,
  type ApiCredentialDraft,
  type ApiCredentialKind,
} from '@/components/integrations/api-credential-presets'
import { HTTP_AUTH_TYPES } from '@/features/flows/http-auth'
import { warehouseKindForProvider } from '@/lib/warehouse/hosts'

const draft = (kind: ApiCredentialKind, fields: Partial<ApiCredentialDraft>): ApiCredentialDraft => ({
  ...EMPTY_API_CREDENTIAL_DRAFT,
  kind,
  ...fields,
})

function payload(kind: ApiCredentialKind, fields: Partial<ApiCredentialDraft>) {
  const result = buildApiCredentialPayload(draft(kind, fields))
  assert.ok(result.ok, result.ok ? '' : result.error)
  return result.payload
}

function refusal(kind: ApiCredentialKind, fields: Partial<ApiCredentialDraft>): string {
  const result = buildApiCredentialPayload(draft(kind, fields))
  assert.equal(result.ok, false)
  return result.ok ? '' : result.error
}

test('a bare host is read as https; garbage is refused with a sentence', () => {
  assert.equal(parseAddress('api.acme.com/v1')?.toString(), 'https://api.acme.com/v1')
  assert.equal(parseAddress('localhost'), null)
  assert.equal(parseAddress('ftp://files.acme.com'), null)
  assert.match(refusal('bearer', { address: 'not a url', token: 't' }), /Enter the API’s address/)
})

test('an API key becomes header or query auth with the named key', () => {
  const header = payload('api_key', { address: 'https://api.acme.com', keyName: 'X-API-Key', keyValue: ' k1 ' })
  assert.equal(header.authType, 'header')
  assert.deepEqual(header.config, { name: 'X-API-Key', value: 'k1' })
  const query = payload('api_key', { address: 'https://api.acme.com', keyPlacement: 'query', keyName: 'api_key', keyValue: 'k1' })
  assert.equal(query.authType, 'query')
  assert.match(refusal('api_key', { address: 'https://api.acme.com', keyValue: 'k1' }), /header name/)
})

test('a JWT pasted with its "Bearer" prefix is stored without it', () => {
  const saved = payload('bearer', { address: 'https://api.acme.com', token: 'Bearer eyJhbGciOi.x.y' })
  assert.equal(saved.authType, 'bearer')
  assert.deepEqual(saved.config, { token: 'eyJhbGciOi.x.y' })
})

test('client ID and secret map onto each way an API takes them', () => {
  const oauth = payload('client_credentials', {
    address: 'https://api.acme.com',
    clientId: 'id',
    clientSecret: 'secret',
    tokenUrl: 'auth.acme.com/oauth/token',
    scope: 'read',
  })
  assert.equal(oauth.authType, 'oauth2')
  assert.deepEqual(oauth.config, { tokenUrl: 'https://auth.acme.com/oauth/token', clientId: 'id', clientSecret: 'secret', scope: 'read' })
  assert.match(refusal('client_credentials', { address: 'https://api.acme.com', clientId: 'id', clientSecret: 's' }), /token URL/)

  const basic = payload('client_credentials', { address: 'https://api.acme.com', clientMode: 'basic', clientId: 'id', clientSecret: 's' })
  assert.equal(basic.authType, 'basic')
  assert.deepEqual(basic.config, { username: 'id', password: 's' })

  const headers = payload('client_credentials', { address: 'https://api.acme.com', clientMode: 'headers', clientId: 'id', clientSecret: 's' })
  assert.equal(headers.authType, 'custom')
  assert.deepEqual(JSON.parse(headers.config.headersJson), { 'X-Client-Id': 'id', 'X-Client-Secret': 's' })
})

test('Snowflake verifies against the statements API and refuses a non-Snowflake host', () => {
  const pat = payload('snowflake', { address: 'acme-prod.snowflakecomputing.com', token: 'pat' })
  assert.equal(pat.authType, 'snowflake_pat')
  assert.equal(pat.url, 'https://acme-prod.snowflakecomputing.com/api/v2/statements')

  const keypair = payload('snowflake', {
    address: 'acme-prod.snowflakecomputing.com',
    snowflakeMode: 'keypair',
    snowflakeUser: 'SVC',
    privateKey: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
  })
  assert.equal(keypair.authType, 'snowflake_keypair')
  assert.equal(keypair.config.user, 'SVC')
  assert.equal('passphrase' in keypair.config, false)

  assert.match(refusal('snowflake', { address: 'api.acme.com', token: 'pat' }), /snowflakecomputing\.com/)
  assert.match(refusal('snowflake', { address: 'acme.snowflakecomputing.com', snowflakeMode: 'keypair', snowflakeUser: 'SVC', privateKey: 'nope' }), /PEM/)
})

test('Databricks takes a PAT as bearer, or a service principal via the workspace OIDC endpoint', () => {
  const pat = payload('databricks', { address: 'https://dbc-1.cloud.databricks.com/', token: 'dapi123' })
  assert.equal(pat.authType, 'bearer')
  assert.equal(pat.url, 'https://dbc-1.cloud.databricks.com/api/2.0/preview/scim/v2/Me')

  const sp = payload('databricks', { address: 'adb-9.azuredatabricks.net', databricksMode: 'service_principal', clientId: 'id', clientSecret: 's' })
  assert.equal(sp.authType, 'oauth2')
  assert.equal(sp.config.tokenUrl, 'https://adb-9.azuredatabricks.net/oidc/v1/token')
  assert.equal(sp.config.scope, 'all-apis')

  assert.match(refusal('databricks', { address: 'acme.snowflakecomputing.com', token: 't' }), /Databricks address/)
})

test('every preset saves an auth type the credential API accepts', () => {
  const accepted = new Set<string>(HTTP_AUTH_TYPES)
  const samples = [
    payload('api_key', { address: 'a.io', keyName: 'k', keyValue: 'v' }),
    payload('bearer', { address: 'a.io', token: 't' }),
    payload('basic', { address: 'a.io', username: 'u', password: 'p' }),
    payload('client_credentials', { address: 'a.io', clientId: 'i', clientSecret: 's', tokenUrl: 'a.io/t' }),
    payload('snowflake', { address: 'x.snowflakecomputing.com', token: 't' }),
    payload('databricks', { address: 'x.cloud.databricks.com', token: 't' }),
  ]
  for (const sample of samples) assert.ok(accepted.has(sample.authType), sample.authType)
  // An unnamed credential still gets a readable name.
  assert.equal(samples[1].name, 'a.io · Bearer or JWT token')
})

test('Snowflake and Databricks catalog entries are recognised as warehouses', () => {
  assert.equal(warehouseKindForProvider('snowflake'), 'snowflake')
  assert.equal(warehouseKindForProvider('Databricks'), 'databricks')
  assert.equal(warehouseKindForProvider('salesforce'), null)
})

// Rishab (2026-11-17): a non-admin clicking Connect on Snowflake/Databricks got
// "You do not have permission to do that." — /api/nango/session-token required
// integration.manage, so no member could connect even their own account.
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

test('members can start, verify and remove their OWN Nango connections', () => {
  assert.match(read('src/app/api/nango/session-token/route.ts'), /permission: 'flow\.run'/)
  const verify = read('src/app/api/nango/connections/[integrationId]/verify/route.ts')
  assert.match(verify, /permission: 'flow\.run'/)
  assert.match(verify, /ownConnectionIdsUnlessAdmin/, 'a member must verify only their own accounts')
  const remove = read('src/app/api/nango/connections/[integrationId]/route.ts')
  assert.match(remove, /permission: 'flow\.run'/)
  assert.match(remove, /!auth\.can\('integration\.manage'\)[\s\S]*userId: auth\.dbUser\.id/, 'a member must disconnect only their own accounts')
})

test('warehouse cards and the credentials page route Snowflake/Databricks to the credential form', () => {
  for (const file of ['src/app/integrations/oauth-integrations-grid.tsx', 'src/app/credentials/page.tsx']) {
    const source = read(file)
    assert.match(source, /warehouseKindForProvider/, `${file} must not send warehouses through Nango`)
    assert.match(source, /ApiCredentialDialog/, `${file} must open the credential form`)
  }
  assert.match(read('src/app/credentials/page.tsx'), /canConnectOwn && \(/, 'members must see the connect affordances')
})
