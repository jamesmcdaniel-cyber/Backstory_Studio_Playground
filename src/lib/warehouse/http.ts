import { fetchPublicUrl } from '@/lib/net/ssrf'
import { readResponseTextLimited } from '@/lib/net/response-body'
import { applyHttpCredential, type ResolvedHttpCredential } from '@/features/flows/http-auth'

/**
 * The one way a warehouse client talks to its host.
 *
 * Every Databricks and Snowflake request goes through here: the saved,
 * host-locked HTTP credential is applied by applyHttpCredential (so the secret
 * never leaves the credential store or enters flow data), the address is
 * SSRF-checked and pinned by fetchPublicUrl, redirects are refused (a bounced
 * request would carry the credential to whatever host the bounce named), each
 * request is bounded in time, and each response in size.
 *
 * The clients take this as an injected function so their submit / poll /
 * paginate protocols are tested with a scripted fake and never a network.
 */
export type WarehouseRequest = (
  path: string,
  init: { method: 'GET' | 'POST'; body?: string },
) => Promise<{ status: number; ok: boolean; text: string }>

export const WAREHOUSE_REQUEST_TIMEOUT_MS = 120_000
/** Per-response read cap: a Databricks chunk or Snowflake partition runs to a few MB. */
export const WAREHOUSE_RESPONSE_MAX_BYTES = 64_000_000

export function credentialedWarehouseRequest(
  host: string,
  credential: ResolvedHttpCredential,
  options: { label: string; headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number },
): WarehouseRequest {
  return async (path, init) => {
    const url = `https://${host}${path.startsWith('/') ? path : `/${path}`}`
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    }
    const request = await applyHttpCredential({ url, init: { method: init.method, headers, body: init.body } }, credential)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? WAREHOUSE_REQUEST_TIMEOUT_MS)
    try {
      const response = await fetchPublicUrl(request.url, { ...request.init, signal: controller.signal }, { maxRedirects: 0 })
      const text = await readResponseTextLimited(response, options.maxBytes ?? WAREHOUSE_RESPONSE_MAX_BYTES, options.label)
      return { status: response.status, ok: response.ok, text }
    } finally {
      clearTimeout(timer)
    }
  }
}

export const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
