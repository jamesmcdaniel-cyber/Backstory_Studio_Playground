import assert from 'node:assert/strict'
import type { WarehouseRequest } from '../http'

export type ScriptStep = { match: RegExp; method?: 'GET' | 'POST'; status?: number; body: unknown }

/**
 * A warehouse that answers from a script, in order. Each request must match
 * the next step's path pattern (and method, when given); anything unscripted
 * fails the test. No network is ever touched.
 */
export function fakeWarehouse(script: ScriptStep[]) {
  const calls: Array<{ path: string; method: string; body?: string }> = []
  const request: WarehouseRequest = async (path, init) => {
    calls.push({ path, method: init.method, ...(init.body ? { body: init.body } : {}) })
    const step = script.shift()
    if (!step) throw new Error(`unexpected request ${init.method} ${path}`)
    assert.match(path, step.match)
    if (step.method) assert.equal(init.method, step.method)
    const status = step.status ?? 200
    return { status, ok: status >= 200 && status < 300, text: typeof step.body === 'string' ? step.body : JSON.stringify(step.body) }
  }
  return { request, calls, remaining: script }
}

export const noSleep = async () => {}
