import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeUpstreamFailure } from '../upstream-error'

test('a plain error is passed through unchanged', () => {
  assert.equal(describeUpstreamFailure(new Error('Boom')), 'Boom')
})

test("an axios-shaped failure carries the provider's own message", () => {
  const error = Object.assign(new Error('Request failed with status code 400'), {
    response: {
      status: 400,
      data: { error: { code: 400, message: "Invalid value at 'message.raw' (TYPE_BYTES)", status: 'INVALID_ARGUMENT' } },
    },
  })
  const described = describeUpstreamFailure(error)
  assert.match(described, /Request failed with status code 400/)
  assert.match(described, /Invalid value at 'message\.raw'/)
})

test('a string error body is surfaced too', () => {
  const error = Object.assign(new Error('Request failed with status code 400'), {
    response: { status: 400, data: 'Unknown provider config key' },
  })
  assert.match(describeUpstreamFailure(error), /Unknown provider config key/)
})

test('a nested Nango payload message is preferred over the raw JSON dump', () => {
  const error = Object.assign(new Error('Request failed with status code 400'), {
    response: { status: 400, data: { message: 'Missing provider config key' } },
  })
  const described = describeUpstreamFailure(error)
  assert.match(described, /Missing provider config key/)
  assert.equal(described.includes('{'), false, 'a readable message should not be shown as JSON')
})

test('a readable message wins, and the rest of the body never ships', () => {
  const error = Object.assign(new Error('Request failed with status code 400'), {
    response: { status: 400, data: { message: 'bad request', authorization: 'Bearer ya29.SECRETVALUE' } },
  })
  const described = describeUpstreamFailure(error)
  assert.match(described, /bad request/)
  assert.equal(described.includes('ya29.SECRETVALUE'), false, 'a token must never reach a run log')
})

test('a body with no readable message is dumped with its secrets redacted', () => {
  const error = Object.assign(new Error('Request failed with status code 400'), {
    response: { status: 400, data: { reason: 'nope', authorization: 'Bearer ya29.SECRETVALUE' } },
  })
  const described = describeUpstreamFailure(error)
  assert.match(described, /nope/)
  assert.equal(described.includes('ya29.SECRETVALUE'), false, 'a token must never reach a run log')
  assert.match(described, /REDACTED/)
})

test('a bearer token in free-text prose is scrubbed', () => {
  const error = Object.assign(new Error('Request failed with status code 400'), {
    response: { status: 400, data: 'rejected Bearer ya29.SECRETVALUE for this call' },
  })
  const described = describeUpstreamFailure(error)
  assert.equal(described.includes('ya29.SECRETVALUE'), false)
  assert.match(described, /Bearer \[REDACTED\]/)
})

test('an enormous upstream body is truncated rather than pasted whole', () => {
  const error = Object.assign(new Error('Request failed with status code 400'), {
    response: { status: 400, data: { detail: 'x'.repeat(5_000) } },
  })
  assert.ok(describeUpstreamFailure(error).length < 1_000)
})

test('a failure with no response body is left exactly as it was', () => {
  const error = Object.assign(new Error('socket hang up'), { response: undefined })
  assert.equal(describeUpstreamFailure(error), 'socket hang up')
})
