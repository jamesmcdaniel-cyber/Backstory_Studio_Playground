import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCurl } from '../curl'

test('parses a simple GET with headers', () => {
  const result = parseCurl(`curl https://api.example.com/v1/items -H 'Accept: application/json'`)
  assert.equal(result.url, 'https://api.example.com/v1/items')
  assert.equal(result.method, undefined)
  assert.equal(result.sendHeaders, true)
  assert.deepEqual(JSON.parse(result.headers!), { Accept: 'application/json' })
})

test('parses a POST with a JSON body and infers json mode', () => {
  const result = parseCurl(`curl -X POST https://api.example.com/users \\
    -H "Content-Type: application/json" \\
    -d '{"name":"Ada","age":36}'`)
  assert.equal(result.method, 'POST')
  assert.equal(result.url, 'https://api.example.com/users')
  assert.equal(result.bodyMode, 'json')
  assert.equal(result.sendBody, true)
  assert.deepEqual(JSON.parse(result.body!), { name: 'Ada', age: 36 })
})

test('infers POST when data is present without an explicit method', () => {
  const result = parseCurl(`curl https://x.test -d 'a=1&b=2'`)
  assert.equal(result.method, 'POST')
  assert.equal(result.bodyMode, 'form-urlencoded')
  assert.equal(result.body, 'a=1&b=2')
})

test('handles --data-urlencode and joins parts', () => {
  const result = parseCurl(`curl https://x.test --data-urlencode 'q=hello world' --data-urlencode 'p=2'`)
  assert.equal(result.bodyMode, 'form-urlencoded')
  assert.equal(result.body, 'q=hello world&p=2')
})

test('detects --location as follow redirects and --url', () => {
  const result = parseCurl(`curl -L --url https://x.test/redirect`)
  assert.equal(result.followRedirects, true)
  assert.equal(result.url, 'https://x.test/redirect')
})

test('does not write basic-auth creds into the config', () => {
  const result = parseCurl(`curl -u alice:secret https://x.test`)
  assert.equal(result.url, 'https://x.test')
  assert.equal(result.headers, undefined)
  assert.equal(result.body, undefined)
})

test('parses the --json shorthand', () => {
  const result = parseCurl(`curl --json '{"ok":true}' https://x.test`)
  assert.equal(result.bodyMode, 'json')
  assert.deepEqual(JSON.parse(result.headers!), { 'Content-Type': 'application/json' })
})
