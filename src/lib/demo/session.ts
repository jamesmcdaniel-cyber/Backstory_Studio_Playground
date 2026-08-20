/**
 * Demo-mode session: which sandbox, if any, this request should operate in.
 *
 * The session is one httpOnly cookie naming a demo org id. Resolution is
 * deliberately paranoid and quiet: the cookie is a CLAIM, verified against the
 * database on every request (the org must exist, be kind 'demo', and be owned
 * by this exact user), and any mismatch — stale cookie after teardown, someone
 * else's cookie value, a tampered id — resolves to null and the request
 * proceeds in the real workspace. A demo cookie must never be able to 500 a
 * session or grant a different tenant.
 */

import { cookies } from 'next/headers'
import { systemPrisma } from '@/lib/prisma'

export const DEMO_COOKIE = 'backstory-demo'

// Production-inert test seam, same pattern (and reasoning) as the auth seam in
// src/lib/server/auth.ts: DB-backed tests drive real handlers without a
// browser to carry cookies. Symbol.for so tsx's CJS/ESM duality cannot split
// the slot across module instances.
const TEST_COOKIE_SLOT = Symbol.for('backstory.demoCookie')

export function setTestDemoCookie(value: string | null): void {
  ;(globalThis as Record<symbol, unknown>)[TEST_COOKIE_SLOT] = value
}

function testDemoCookie(): string | null {
  if (process.env.NODE_ENV === 'production' || !process.env.TEST_DATABASE_URL) return null
  return ((globalThis as Record<symbol, unknown>)[TEST_COOKIE_SLOT] as string | null) ?? null
}

async function demoCookieValue(): Promise<string | null> {
  const injected = testDemoCookie()
  if (injected) return injected
  try {
    return (await cookies()).get(DEMO_COOKIE)?.value ?? null
  } catch {
    // No request scope (worker, background job) — no demo session by definition.
    return null
  }
}

/**
 * The demo org this request should operate in, or null for the real workspace.
 * Verified ownership, never trusted from the cookie alone.
 */
export async function resolveDemoOrganization(userId: string): Promise<string | null> {
  const claimed = await demoCookieValue()
  if (!claimed) return null
  // systemPrisma: the lookup verifies a cross-tenant claim (cookie → org row)
  // before any tenant context exists for this request; it reads only the row
  // named by the cookie and admits it only on exact owner match.
  const org = await systemPrisma.organization.findUnique({
    where: { id: claimed },
    select: { kind: true, demoOwnerUserId: true },
  }).catch(() => null)
  if (!org || org.kind !== 'demo' || org.demoOwnerUserId !== userId) return null
  return claimed
}
