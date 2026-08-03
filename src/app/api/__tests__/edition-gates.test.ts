import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NextRequest } from 'next/server'

/**
 * Route dirs relative to src/app/api that are internal-edition only.
 *
 * The completeness test at the bottom fails the build if this drifts from what
 * is actually gated on disk, so adding an internal-only surface stays a
 * deliberate customer-edition decision rather than an accident.
 */
export const INTERNAL_ONLY_ROUTES = [
  'template-proposals',
  'template-proposals/[id]/accept',
  'template-proposals/[id]/dismiss',
  'catalogue/staff',
  'catalogue/review',
  'catalogue/review/[id]',
  'catalogue/entries',
  'catalogue/entries/[id]',
  // Operator ops surfaces behind /admin. Both reach across every workspace via
  // systemPrisma — costs aggregates spend per org, domains mutates users in
  // other tenants — so they belong to the internal edition for the same reason
  // the staff console does.
  'admin/costs',
  'admin/domains',
]

const cases: Array<{ name: string; load: () => Promise<Record<string, unknown>>; methods: string[] }> = [
  { name: 'template-proposals', load: () => import('../template-proposals/route'), methods: ['GET'] },
  { name: 'template-proposals/[id]/accept', load: () => import('../template-proposals/[id]/accept/route'), methods: ['POST'] },
  { name: 'template-proposals/[id]/dismiss', load: () => import('../template-proposals/[id]/dismiss/route'), methods: ['POST'] },
  { name: 'catalogue/staff', load: () => import('../catalogue/staff/route'), methods: ['GET', 'PATCH'] },
  { name: 'catalogue/review', load: () => import('../catalogue/review/route'), methods: ['GET'] },
  { name: 'catalogue/review/[id]', load: () => import('../catalogue/review/[id]/route'), methods: ['POST'] },
  { name: 'catalogue/entries', load: () => import('../catalogue/entries/route'), methods: ['GET'] },
  { name: 'catalogue/entries/[id]', load: () => import('../catalogue/entries/[id]/route'), methods: ['DELETE'] },
  { name: 'admin/costs', load: () => import('../admin/costs/route'), methods: ['GET'] },
  { name: 'admin/domains', load: () => import('../admin/domains/route'), methods: ['GET', 'POST', 'PATCH'] },
]

const BODYLESS = new Set(['GET', 'DELETE'])

afterEach(() => { delete process.env.APP_EDITION })

describe('customer edition route gates', () => {
  for (const routeCase of cases) {
    for (const method of routeCase.methods) {
      test(`${method} /api/${routeCase.name} 404s in the customer edition`, async () => {
        process.env.APP_EDITION = 'customer'
        const mod = await routeCase.load()
        const handler = mod[method] as (r: NextRequest, c?: unknown) => Promise<Response>
        assert.equal(typeof handler, 'function', `${method} is not exported`)

        const response = await handler(
          new NextRequest(`http://localhost/api/${routeCase.name}`, {
            method,
            ...(BODYLESS.has(method) ? {} : { body: '{}' }),
          }),
          { params: Promise.resolve({ id: 'x' }) },
        )

        assert.equal(response.status, 404)
      })
    }
  }

  test('an ungated route still answers in the customer edition', async () => {
    process.env.APP_EDITION = 'customer'
    const mod = await import('../agent-templates/route')
    const handler = mod.GET as (r: NextRequest) => Promise<Response>

    const response = await handler(new NextRequest('http://localhost/api/agent-templates', { method: 'GET' }))

    assert.notEqual(response.status, 404, 'the gate must be selective, not blanket')
  })
})

describe('gate inventory', () => {
  test('every internalOnly route is in the documented inventory, and vice versa', () => {
    const apiDir = fileURLToPath(new URL('..', import.meta.url))
    const walk = (dir: string): string[] => {
      const out: string[] = []
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__') continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) out.push(...walk(full))
        else if (entry.name === 'route.ts') out.push(full)
      }
      return out
    }

    const onDisk = walk(apiDir)
      .filter((file) => /internalOnly:\s*true/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(apiDir, path.dirname(file)))
      .sort()

    assert.deepEqual(
      onDisk,
      [...INTERNAL_ONLY_ROUTES].sort(),
      'internalOnly routes drifted from INTERNAL_ONLY_ROUTES. Adding an internal-only route is a deliberate customer-edition decision: add it to the inventory above with a 404 case, or remove the gate.',
    )
  })
})
