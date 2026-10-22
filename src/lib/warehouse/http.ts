import { fetchPublicUrl } from '@/lib/net/ssrf'
import { readResponseBytesLimited, readResponseTextLimited } from '@/lib/net/response-body'
import { applyHttpCredential, type ResolvedHttpCredential } from '@/features/flows/http-auth'

/**
 * The one way a warehouse client talks to its host.
 *
 * Every Databricks and Snowflake request goes through here: the saved,
 * host-locked HTTP credential is applied by applyHttpCredential (so the secret
 * never leaves the credential store or enters flow data), the address is
 * SSRF-checked and pinned by fetchPublicUrl, redirects are refused (a bounced
 * request would carry the credential to whatever host the bounce named), each
 * request is bounded in time, and each response in size — streamed, so an
 * oversized body is cut off while it arrives rather than after it is buffered.
 *
 * The clients take this as an injected function so their submit / poll /
 * paginate protocols are tested with a scripted fake and never a network.
 */
export type WarehouseRequestInit = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  /** JSON text (sent as application/json), or raw bytes (a file upload). */
  body?: string | Uint8Array
  /** Content type of a byte body; defaults to application/octet-stream. */
  contentType?: string
  /** Read a successful response as bytes (a file download) rather than text. */
  binary?: boolean
  /** A tighter response cap for this one call (a download's file-size ceiling). */
  maxBytes?: number
}

export type WarehouseResponse = {
  status: number
  ok: boolean
  /** The body as text — empty for a binary read. */
  text: string
  /** The body, when the call asked for `binary` and the response succeeded. */
  bytes?: Uint8Array
  /** Response headers, lowercased (file metadata reads them). */
  headers?: Record<string, string>
}

export type WarehouseRequest = (path: string, init: WarehouseRequestInit) => Promise<WarehouseResponse>

export const WAREHOUSE_REQUEST_TIMEOUT_MS = 120_000
/** Per-response read cap: a Databricks chunk or Snowflake partition runs to a few MB. */
export const WAREHOUSE_RESPONSE_MAX_BYTES = 64_000_000
/** An error body is read as text even on a binary call, and never needs to be large. */
const ERROR_BODY_MAX_BYTES = 256_000

export function credentialedWarehouseRequest(
  host: string,
  credential: ResolvedHttpCredential,
  options: {
    label: string
    headers?: Record<string, string>
    timeoutMs?: number
    maxBytes?: number
    /** Test seam: stands in for the network, underneath the SSRF guard. */
    fetchImpl?: typeof fetch
  },
): WarehouseRequest {
  return async (path, init) => {
    const url = `https://${host}${path.startsWith('/') ? path : `/${path}`}`
    const bytesBody = init.body instanceof Uint8Array
    const headers: Record<string, string> = {
      accept: init.binary ? '*/*' : 'application/json',
      ...(init.body !== undefined
        ? { 'content-type': bytesBody ? init.contentType || 'application/octet-stream' : 'application/json' }
        : {}),
      ...(options.headers ?? {}),
    }
    // A Uint8Array may view a shared pool; send exactly its bytes.
    const body: BodyInit | undefined = init.body === undefined
      ? undefined
      : bytesBody ? new Blob([new Uint8Array(init.body as Uint8Array)]) : init.body as string
    const request = await applyHttpCredential({ url, init: { method: init.method, headers, body } }, credential)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? WAREHOUSE_REQUEST_TIMEOUT_MS)
    try {
      const response = await fetchPublicUrl(
        request.url,
        { ...request.init, signal: controller.signal },
        { maxRedirects: 0, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) },
      )
      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, name) => { responseHeaders[name.toLowerCase()] = value })
      const ceiling = options.maxBytes ?? WAREHOUSE_RESPONSE_MAX_BYTES
      const cap = Math.min(init.maxBytes ?? ceiling, ceiling)
      if (init.binary && response.ok) {
        const bytes = await readResponseBytesLimited(response, cap, options.label)
        return { status: response.status, ok: true, text: '', bytes, headers: responseHeaders }
      }
      const text = await readResponseTextLimited(response, response.ok ? cap : Math.min(cap, ERROR_BODY_MAX_BYTES), options.label)
      return { status: response.status, ok: response.ok, text, headers: responseHeaders }
    } finally {
      clearTimeout(timer)
    }
  }
}

export const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
