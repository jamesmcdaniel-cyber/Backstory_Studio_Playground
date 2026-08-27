import { test } from 'node:test'
import assert from 'node:assert/strict'
import { injectTraceContext, openTelemetryConfigured, safeSpanAttributes } from '../otel'

test('OpenTelemetry is opt-in and respects the SDK disable switch', () => {
  assert.equal(openTelemetryConfigured({}), false)
  assert.equal(openTelemetryConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.test' }), true)
  assert.equal(openTelemetryConfigured({
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://collector.test/v1/traces',
    OTEL_SDK_DISABLED: 'true',
  }), false)
})

test('span attributes drop secret-shaped keys and non-primitive payloads', () => {
  assert.deepEqual(safeSpanAttributes({
    'backstory.flow.id': 'flow-1',
    retries: 2,
    enabled: true,
    authorization: 'Bearer secret',
    'provider.api_key': 'secret',
    output: { private: true },
    invalid: Number.NaN,
  }), {
    'backstory.flow.id': 'flow-1',
    retries: 2,
    enabled: true,
  })
})

test('queue injection is a safe no-op without an active recording context', () => {
  const value = injectTraceContext({ id: 'job-1' })
  assert.equal(value.id, 'job-1')
  assert.equal(value.traceContext, undefined)
})
