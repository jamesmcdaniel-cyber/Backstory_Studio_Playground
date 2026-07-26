import assert from 'node:assert/strict'
import test from 'node:test'
import { applyHttpCredential } from '../http-auth'

const request = () => ({
  url: 'https://api.example.com/items?existing=1',
  init: { method: 'GET', headers: { accept: 'application/json' } } as RequestInit,
})

test('generic HTTP credentials apply Basic, Bearer, Header, and Query auth', async () => {
  const basic = await applyHttpCredential(request(), {
    authType: 'basic',
    allowedHost: 'api.example.com',
    config: { username: 'user', password: 'pass' },
  })
  assert.equal(new Headers(basic.init.headers).get('authorization'), `Basic ${Buffer.from('user:pass').toString('base64')}`)

  const bearer = await applyHttpCredential(request(), {
    authType: 'bearer',
    allowedHost: 'api.example.com',
    config: { token: 'secret-token' },
  })
  assert.equal(new Headers(bearer.init.headers).get('authorization'), 'Bearer secret-token')

  const header = await applyHttpCredential(request(), {
    authType: 'header',
    allowedHost: 'api.example.com',
    config: { name: 'X-API-Key', value: 'key-1' },
  })
  assert.equal(new Headers(header.init.headers).get('x-api-key'), 'key-1')

  const query = await applyHttpCredential(request(), {
    authType: 'query',
    allowedHost: 'api.example.com',
    config: { name: 'api_key', value: 'key-1' },
  })
  assert.equal(new URL(query.url).searchParams.get('api_key'), 'key-1')
  assert.equal(new URL(query.url).searchParams.get('existing'), '1')
})

test('generic HTTP credentials cannot be replayed to another API host', async () => {
  await assert.rejects(
    () => applyHttpCredential(request(), {
      authType: 'bearer',
      allowedHost: 'other.example.com',
      config: { token: 'secret-token' },
    }),
    /restricted to other\.example\.com/,
  )
})

test('custom auth applies JSON headers and query values', async () => {
  const applied = await applyHttpCredential(request(), {
    authType: 'custom',
    allowedHost: 'api.example.com',
    config: {
      headersJson: '{"X-Tenant":"acme"}',
      queryJson: '{"region":"us"}',
    },
  })
  assert.equal(new Headers(applied.init.headers).get('x-tenant'), 'acme')
  assert.equal(new URL(applied.url).searchParams.get('region'), 'us')
})
