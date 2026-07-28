import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foreignReferences, unresolvedAuthHeaders, foreignReferenceMessage, unresolvedAuthMessage } from '../foreign-reference'

// ── foreign expression syntax ───────────────────────────────────────────────

test('flags a Power Automate body() accessor', () => {
  assert.deepEqual(
    foreignReferences("body('HTTP_action_—_get_OAuth_token')?['access_token']"),
    ["body('HTTP_action_—_get_OAuth_token')?['access_token']"],
  )
})

test('flags Logic Apps outputs()/triggerBody()/items() calls', () => {
  assert.equal(foreignReferences("outputs('Compose')").length, 1)
  assert.equal(foreignReferences('triggerBody()').length, 1)
  assert.equal(foreignReferences("items('Apply_to_each')").length, 1)
})

test('flags an @{...} interpolation', () => {
  assert.equal(foreignReferences("@{variables('token')}").length, 1)
})

test('walks nested objects and arrays', () => {
  const found = foreignReferences({
    headers: { authorization: "Bearer @{body('Get_token')?['access_token']}" },
    list: ["outputs('X')"],
  })
  assert.equal(found.length, 2)
})

test('leaves this engine’s own token syntax alone', () => {
  assert.deepEqual(foreignReferences('Bearer {{step.n2.output.body.access_token}}'), [])
})

test('does not flag ordinary prose, JSON, or GraphQL bodies', () => {
  assert.deepEqual(foreignReferences('The body of the email goes here.'), [])
  assert.deepEqual(foreignReferences('{"body": "hello", "items": [1, 2]}'), [])
  assert.deepEqual(foreignReferences('{ user(id: 1) { body items } }'), [])
})

test('does not flag a real bearer token', () => {
  assert.deepEqual(foreignReferences('Bearer eyJhbGciOiJIUzI1NiJ9.abc-123_XYZ'), [])
})

// ── unresolved auth header values ───────────────────────────────────────────

test('flags a single-brace placeholder left in an Authorization header', () => {
  assert.deepEqual(unresolvedAuthHeaders({ 'Content-Type': 'application/json', Authorization: 'Bearer {Output}' }), [
    'Authorization',
  ])
})

test('flags a placeholder in proxy-authorization regardless of case', () => {
  assert.deepEqual(unresolvedAuthHeaders({ 'Proxy-Authorization': '{token}' }), ['Proxy-Authorization'])
})

test('flags an auth header left with foreign expression syntax', () => {
  assert.deepEqual(unresolvedAuthHeaders({ authorization: "Bearer body('Get_token')?['access_token']" }), ['authorization'])
})

test('accepts a real resolved credential', () => {
  assert.deepEqual(unresolvedAuthHeaders({ Authorization: 'Bearer REAL-TOKEN-123' }), [])
  assert.deepEqual(unresolvedAuthHeaders({ Authorization: 'Basic dXNlcjpwYXNz' }), [])
})

test('ignores non-auth headers holding braces', () => {
  assert.deepEqual(unresolvedAuthHeaders({ 'X-Template': '{Output}' }), [])
})

test('tolerates a JSON string or a non-object headers value', () => {
  assert.deepEqual(unresolvedAuthHeaders('{"Authorization":"Bearer {Output}"}'), ['Authorization'])
  assert.deepEqual(unresolvedAuthHeaders(undefined), [])
  assert.deepEqual(unresolvedAuthHeaders('not json'), [])
})

test('an empty auth value is not reported here', () => {
  // Blank credentials are the injection path's concern, not an unresolved reference.
  assert.deepEqual(unresolvedAuthHeaders({ Authorization: '   ' }), [])
})

// ── messages ────────────────────────────────────────────────────────────────

test('messages name the offending text in plain english', () => {
  const message = foreignReferenceMessage(["body('Get_token')?['access_token']"])
  assert.match(message, /body\('Get_token'\)/)
  assert.match(message, /another automation tool/i)
  assert.match(message, /data menu/i)

  const auth = unresolvedAuthMessage(['Authorization'])
  assert.match(auth, /Authorization/)
  assert.match(auth, /placeholder/i)
})
