import {
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Attributes,
  type Context,
  type Span,
  type TimeInput,
} from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { NodeSDK } from '@opentelemetry/sdk-node'
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
} from '@opentelemetry/semantic-conventions'

const TRACER_NAME = 'backstory-studio'
const TRACE_CARRIER_KEYS = new Set(['traceparent', 'tracestate'])
const SENSITIVE_ATTRIBUTE_KEY = /(^|[._-])(authorization|cookie|credential|dsn|password|secret|token|api[._-]?key|private[._-]?key)([._-]|$)/i
const MAX_ATTRIBUTE_STRING = 500

let sdk: NodeSDK | null = null

/**
 * OTLP is deliberately opt-in. Merely importing this module never opens a
 * socket and local/test processes stay no-op unless an endpoint is supplied.
 */
export function openTelemetryConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (/^(1|true|yes)$/i.test(env.OTEL_SDK_DISABLED ?? '')) return false
  return Boolean(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT)
}

/**
 * Keep high-cardinality output, prompts, headers and credentials out of the
 * telemetry plane. Callers provide identifiers and operational state only;
 * this final filter makes accidental secret-like attributes fail closed.
 */
export function safeSpanAttributes(values: Record<string, unknown>): Attributes {
  const safe: Attributes = {}
  for (const [key, value] of Object.entries(values)) {
    if (!key || SENSITIVE_ATTRIBUTE_KEY.test(key) || value == null) continue
    if (typeof value === 'string') safe[key] = value.slice(0, MAX_ATTRIBUTE_STRING)
    else if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value
    else if (typeof value === 'boolean') safe[key] = value
  }
  return safe
}

/** Start one process-wide OTLP trace provider. Safe no-op when unconfigured. */
export function initializeOpenTelemetry(processTag = 'web'): void {
  if (sdk || !openTelemetryConfigured()) return
  try {
    const serviceName = process.env.OTEL_SERVICE_NAME || 'backstory-studio'
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
      'backstory.process': processTag,
    })
    const next = new NodeSDK({
      resource,
      serviceName,
      traceExporter: new OTLPTraceExporter(),
    })
    next.start()
    sdk = next
  } catch (error) {
    // Telemetry is diagnostic infrastructure, never an availability dependency.
    console.error('[otel] initialization failed; tracing disabled', error)
  }
}

/** Flush pending spans during deliberate process shutdown. */
export async function shutdownOpenTelemetry(): Promise<void> {
  const current = sdk
  sdk = null
  if (!current) return
  try {
    await current.shutdown()
  } catch (error) {
    console.error('[otel] shutdown failed', error)
  }
}

function markSpanFailure(span: Span, error: unknown): void {
  // Do not export the raw error message: provider errors can echo request
  // bodies, auth headers or prompts. The application error plane retains the
  // detailed exception under its own redaction and access controls.
  const errorType = error instanceof Error ? error.name : typeof error
  span.setAttribute('error.type', String(errorType).slice(0, 100))
  span.setStatus({ code: SpanStatusCode.ERROR, message: 'operation failed' })
}

/** Run an async operation inside a named active span. */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, unknown>,
  operation: () => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME)
  return tracer.startActiveSpan(name, { attributes: safeSpanAttributes(attributes) }, async (span) => {
    try {
      const result = await operation()
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (error) {
      markSpanFailure(span, error)
      throw error
    } finally {
      span.end()
    }
  })
}

/**
 * Record an already-completed operation using its real timestamps. This is
 * used by the interpreter callback, where step duration is known only after
 * an adapter returns.
 */
export function recordCompletedSpan(
  name: string,
  options: {
    startTime: TimeInput
    endTime: TimeInput
    attributes: Record<string, unknown>
    failed?: boolean
  },
): void {
  const span = trace.getTracer(TRACER_NAME).startSpan(name, {
    startTime: options.startTime,
    attributes: safeSpanAttributes(options.attributes),
  })
  span.setStatus({ code: options.failed ? SpanStatusCode.ERROR : SpanStatusCode.OK })
  span.end(options.endTime)
}

/** Inject only W3C trace context into a durable queue payload. */
export function injectTraceContext<T extends object>(value: T): T & { traceContext?: Record<string, string> } {
  const carrier: Record<string, string> = {}
  propagation.inject(context.active(), carrier)
  const traceContext = Object.fromEntries(
    Object.entries(carrier)
      .filter(([key, item]) => TRACE_CARRIER_KEYS.has(key.toLowerCase()) && typeof item === 'string')
      .map(([key, item]) => [key.toLowerCase(), item.slice(0, 512)]),
  )
  return Object.keys(traceContext).length ? { ...value, traceContext } : value
}

function extractedContext(carrier: Record<string, string> | undefined): Context {
  if (!carrier) return context.active()
  const safeCarrier = Object.fromEntries(
    Object.entries(carrier)
      .filter(([key, value]) => TRACE_CARRIER_KEYS.has(key.toLowerCase()) && typeof value === 'string')
      .map(([key, value]) => [key.toLowerCase(), value.slice(0, 512)]),
  )
  return propagation.extract(context.active(), safeCarrier)
}

/** Continue the enqueueing request's trace when a worker receives the job. */
export function withExtractedTraceContext<T>(
  carrier: Record<string, string> | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  return context.with(extractedContext(carrier), operation)
}
