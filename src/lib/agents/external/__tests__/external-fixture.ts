/**
 * Shared harness for the external-agent DB tests: a stubbed network (the
 * agent's webhook and Slack), a public-resolving SSRF seam, and helpers to
 * register an agent and wait for a run to settle. Imports nothing that builds
 * the Prisma client at module load — callers set TEST_DATABASE_URL first.
 */

import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

export const AGENT_HOST = 'agent.example.test'
export const WEBHOOK_URL = `https://${AGENT_HOST}/hooks/backstory`

export type Captured = { url: string; headers: Record<string, string>; body: string }

export function createNetworkStub() {
  const state = {
    webhookStatus: 200,
    webhook: [] as Captured[],
    slack: [] as Array<{ url: string; body: any }>,
    /** Called inside the webhook request — lets a test answer synchronously. */
    onWebhook: null as null | ((captured: Captured) => Promise<void>),
  }
  const original = globalThis.fetch
  const stub = (async (input: any, init: any = {}) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes(AGENT_HOST)) {
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(init.headers ?? {})) headers[key.toLowerCase()] = String(value)
      const captured = { url, headers, body: String(init.body ?? '') }
      state.webhook.push(captured)
      if (state.onWebhook) await state.onWebhook(captured)
      return new Response(state.webhookStatus < 300 ? '{"ok":true}' : 'nope', { status: state.webhookStatus })
    }
    if (url.includes('slack.com')) {
      state.slack.push({ url, body: JSON.parse(String(init.body ?? '{}')) })
      return Response.json({ ok: true, ts: '1.9' })
    }
    return new Response('not stubbed', { status: 599 })
  }) as typeof fetch
  return {
    state,
    install() { globalThis.fetch = stub },
    restore() { globalThis.fetch = original },
    reset() {
      state.webhookStatus = 200
      state.webhook = []
      state.slack = []
      state.onWebhook = null
    },
  }
}

/** Every host resolves publicly, except the one a test marks private. */
export async function installPublicResolver(privateHost = 'private.example.test') {
  const { __setSsrfResolver, clearPins } = await import('@/lib/net/ssrf')
  clearPins()
  __setSsrfResolver(async (host: string) => (host === privateHost ? [{ address: '10.0.0.5', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]))
  return () => { __setSsrfResolver(null); clearPins() }
}

export async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 8_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() - started > timeoutMs) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

export async function createWorkspace(prisma: any, label: string) {
  const suffix = crypto.randomUUID().slice(0, 8)
  const org = await prisma.organization.create({ data: { name: `${label}-${suffix}`, slug: `${label}-${suffix}` } })
  const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id, name: 'Ada Lovelace', isActive: true } })
  return { orgId: org.id as string, userId: user.id as string }
}

export function replyRequest(executionId: string, apiKey: string, body: unknown, leaf: 'reply' | 'progress' = 'reply') {
  return new NextRequest(`https://studio.example.com/api/v1/agents/executions/${executionId}/${leaf}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 200) + 1}` },
    body: JSON.stringify(body),
  })
}
