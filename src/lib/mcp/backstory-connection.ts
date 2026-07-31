import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

/** The natively-included Backstory MCP server every user connects to. */
export const BACKSTORY_MCP_DEFAULT_URL = 'https://mcp.backstory.ai/mcp'
export const BACKSTORY_PROVIDER = 'backstory'

export function backstoryServerUrl(): string {
  return process.env.BACKSTORY_MCP_URL?.trim() || BACKSTORY_MCP_DEFAULT_URL
}

/**
 * The Backstory MCP gate is enforced in production; in development it
 * defaults off so a fresh clone works. Force with BACKSTORY_MCP_GATE=on|off.
 */
export function backstoryGateEnabled(): boolean {
  const flag = process.env.BACKSTORY_MCP_GATE
  if (flag === 'on') return true
  if (flag === 'off') return false
  return process.env.NODE_ENV === 'production'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/** Pure gate decision over the user's Backstory connection row. */
export function evaluateBackstoryReady(row: { isActive: boolean; authConfig: unknown } | null): boolean {
  if (!row || !row.isActive) return false
  const config = row.authConfig
  if (!isRecord(config)) return false
  return config.flow === 'authcode' && typeof config.accessToken === 'string' && config.accessToken.length > 0
}

/** Loose server-URL equality: case-insensitive, ignores trailing slashes. */
export function sameServerUrl(a: string, b: string): boolean {
  const norm = (value: string) => value.trim().replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b) && norm(a).length > 0
}

/** A pre-existing, user-managed connection to the Backstory server counts as configured. */
export function evaluateExistingBackstoryConnection(
  row: { isActive: boolean; serverUrl: string; authType: string } | null,
  expectedUrl: string,
): boolean {
  if (!row || !row.isActive) return false
  return sameServerUrl(row.serverUrl, expectedUrl)
}

const READY_TTL_MS = 60_000
export function readyCacheFresh(cachedAt: number, now: number = Date.now()): boolean {
  return now - cachedAt < READY_TTL_MS
}

/**
 * Both of these are keyed per org:user, which means they grow with every
 * distinct person the process ever serves. On a serverless instance that is
 * bounded by the instance's lifetime; on the long-lived worker it is not, and
 * `seededMemo` in particular never expired an entry — a slow leak that only
 * shows up at the scale where you can least afford it.
 *
 * Both are pure optimizations: evicting an entry costs one extra query, never
 * correctness. So they are simply capped, oldest-first (Map/Set preserve
 * insertion order).
 */
const MAX_CACHE_ENTRIES = 5_000

function capEntries(collection: Map<string, unknown> | Set<string>): void {
  while (collection.size > MAX_CACHE_ENTRIES) {
    const oldest = collection.keys().next().value
    if (oldest === undefined) return
    collection.delete(oldest)
  }
}

const readyCache = new Map<string, { ready: boolean; cachedAt: number }>()
const seededMemo = new Set<string>()
const cacheKey = (organizationId: string, userId: string) => `${organizationId}:${userId}`

export function bustBackstoryReadyCache(organizationId: string, userId: string): void {
  readyCache.delete(cacheKey(organizationId, userId))
}

/**
 * Idempotently seed the per-user Backstory MCP row (inactive until OAuth
 * completes). Never throws — sign-in must not be blocked by the seeder.
 */
export async function ensureBackstoryConnection(organizationId: string, userId: string): Promise<void> {
  const key = cacheKey(organizationId, userId)
  if (seededMemo.has(key)) return
  try {
    const existingRows = await prisma.mcpConnection.findMany({
      where: { organizationId, provider: null, isActive: true },
      select: { isActive: true, serverUrl: true, authType: true },
      take: 10,
    })
    if (existingRows.some((r) => evaluateExistingBackstoryConnection(r, backstoryServerUrl()))) {
      // A pre-existing, user-managed connection to the Backstory server already
      // satisfies the gate. Don't seed a duplicate per-user "Backstory MCP" row.
      seededMemo.add(key)
      capEntries(seededMemo)
      return
    }
    await prisma.mcpConnection.upsert({
      where: {
        organizationId_userId_provider: {
          organizationId,
          userId,
          provider: BACKSTORY_PROVIDER,
        },
      },
      update: {},
      create: {
        organizationId,
        userId,
        provider: BACKSTORY_PROVIDER,
        name: 'Backstory MCP',
        description: 'Native Backstory tools',
        serverUrl: backstoryServerUrl(),
        authType: 'oauth2',
        authConfig: {},
        isActive: false,
      },
    })
    seededMemo.add(key)
    capEntries(seededMemo)
  } catch (error) {
    apiLogger.warn('Backstory MCP seeding failed; will retry next request', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Cached (60s) gate check: does this user have an authorized Backstory row? */
export async function backstoryMcpReady(organizationId: string, userId: string): Promise<boolean> {
  const key = cacheKey(organizationId, userId)
  const cached = readyCache.get(key)
  if (cached && readyCacheFresh(cached.cachedAt)) return cached.ready
  const row = await prisma.mcpConnection.findFirst({
    where: { organizationId, userId, provider: BACKSTORY_PROVIDER },
    select: { isActive: true, authConfig: true },
  })
  let ready = evaluateBackstoryReady(row)
  if (!ready) {
    // A pre-existing, user-managed connection pointing at the same Backstory
    // server URL also satisfies the gate — users who already configured
    // Backstory MCP should never be forced to re-configure it.
    const existingRows = await prisma.mcpConnection.findMany({
      where: { organizationId, provider: null, isActive: true },
      select: { isActive: true, serverUrl: true, authType: true },
      take: 10,
    })
    // NOTE: serverUrl match is done in JS via sameServerUrl because URL
    // normalization (trailing slash/case) can't be expressed in the query.
    ready = existingRows.some((r) => evaluateExistingBackstoryConnection(r, backstoryServerUrl()))
  }
  readyCache.set(key, { ready, cachedAt: Date.now() })
  capEntries(readyCache)
  return ready
}
