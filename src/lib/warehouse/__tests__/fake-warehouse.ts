import assert from 'node:assert/strict'
import type { WarehouseRequest, WarehouseRequestInit } from '../http'

export type ScriptStep = {
  match: RegExp
  method?: WarehouseRequestInit['method']
  status?: number
  body: unknown
  /** Response headers (file metadata, download content type). */
  headers?: Record<string, string>
}

/**
 * A warehouse that answers from a script, in order. Each request must match
 * the next step's path pattern (and method, when given); anything unscripted
 * fails the test. No network is ever touched. A binary call is answered with
 * the step's body as bytes (a Uint8Array body is passed through as-is).
 */
export function fakeWarehouse(script: ScriptStep[]) {
  const calls: Array<{ path: string; method: string; body?: string; bytes?: Uint8Array; contentType?: string; binary?: boolean; maxBytes?: number }> = []
  const request: WarehouseRequest = async (path, init) => {
    calls.push({
      path,
      method: init.method,
      ...(typeof init.body === 'string' && init.body ? { body: init.body } : {}),
      ...(init.body instanceof Uint8Array ? { bytes: init.body } : {}),
      ...(init.contentType ? { contentType: init.contentType } : {}),
      ...(init.binary ? { binary: true } : {}),
      ...(init.maxBytes !== undefined ? { maxBytes: init.maxBytes } : {}),
    })
    const step = script.shift()
    if (!step) throw new Error(`unexpected request ${init.method} ${path}`)
    assert.match(path, step.match)
    if (step.method) assert.equal(init.method, step.method)
    const status = step.status ?? 200
    const ok = status >= 200 && status < 300
    const text = typeof step.body === 'string' ? step.body : step.body instanceof Uint8Array ? '' : step.body === undefined ? '' : JSON.stringify(step.body)
    if (init.binary && ok) {
      const bytes = step.body instanceof Uint8Array ? step.body : new TextEncoder().encode(text)
      return { status, ok, text: '', bytes, headers: step.headers ?? {} }
    }
    return { status, ok, text, headers: step.headers ?? {} }
  }
  return { request, calls, remaining: script }
}

export const noSleep = async () => {}
