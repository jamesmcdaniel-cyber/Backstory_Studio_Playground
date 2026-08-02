import { test } from 'node:test'
import { NextRequest } from 'next/server'

test('seam-route probe', async () => {
  const authAlias = await import('@/lib/server/auth')
  const authRel = await import('../../../lib/server/auth')
  console.log('alias === relative:', authAlias === authRel)
  const { prisma } = await import('@/lib/prisma')
  const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
  const seeded = await seedTestOrg(prisma)
  authAlias.setTestAuthContext(seeded.auth)
  authRel.setTestAuthContext(seeded.auth)
  const route = await import('../flow-templates/route')
  const res = await route.GET(new NextRequest(new URL('http://test/api/flow-templates')))
  console.log('route status:', res.status)
  await seeded.cleanup()
})
