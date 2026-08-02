/**
 * UI-contract QA: drive the REAL Next route handlers the flows UI calls, in
 * the exact sequence a user takes — gallery → template detail → Use this flow
 * → flows list → builder load → Run → runs panel. Uses the repo's own
 * production-inert test-auth seam (requires TEST_DATABASE_URL + non-prod).
 */
import { test } from 'node:test'
import { NextRequest } from 'next/server'

const req = (path: string, init?: RequestInit) => new NextRequest(new URL(`http://test${path}`), init as never)
const post = (path: string, body: unknown) =>
  new NextRequest(new URL(`http://test${path}`), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  } as never)

async function show(name: string, res: Response) {
  const body = await res.json().catch(() => null)
  console.log(`${name} -> ${res.status}`)
  return body
}

async function main() {
  // All-dynamic imports so the test-auth seam and the route handlers share ONE
  // module instance under tsx (a static import here creates a second copy of
  // auth.ts whose injected context the routes never see).
  const { prisma } = await import('@/lib/prisma')
  const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
  const seeded = await seedTestOrg(prisma)
  // Set the seam on the ALIAS module instance (the one api-handler imports):
  // under plain tsx, test-auth's relative '../auth' import is a second copy.
  const { setTestAuthContext } = await import('@/lib/server/auth')
  setTestAuthContext(seeded.auth)
  console.log('SEEDED org', seeded.organizationId)

  // 1) Gallery: the flows-page template menu + templates tab.
  const list = await show('GET /api/flow-templates', await (await import('@/app/api/flow-templates/route')).GET(req('/api/flow-templates?limit=50')))
  const names = (list.templates ?? list.items ?? list).map?.((t: { id?: string; name?: string }) => t.id ?? t.name)
  console.log('  templates:', JSON.stringify(names))

  // 2) Detail page for a built-in.
  const detail = await show('GET /api/flow-templates/account-plan', await (await import('@/app/api/flow-templates/[id]/route')).GET(req('/api/flow-templates/account-plan')))
  const detailTemplate = detail.template ?? detail
  console.log('  detail keys:', Object.keys(detailTemplate).join(','))

  // 3) "Use this flow" on the no-binding starter (rest of the journey runs it).
  const used = await show('POST /api/flow-templates/summarize-extract/use', await (await import('@/app/api/flow-templates/[id]/use/route')).POST(post('/api/flow-templates/summarize-extract/use', {})))
  console.log('  use response:', JSON.stringify(used).slice(0, 300))
  const flowId: string = used.flow?.id ?? used.flowId ?? used.id
  if (!flowId) throw new Error('no flow id from /use')

  // Also instantiate account-plan to check the setup checklist surfaces.
  const usedPlan = await show('POST /api/flow-templates/account-plan/use', await (await import('@/app/api/flow-templates/[id]/use/route')).POST(post('/api/flow-templates/account-plan/use', {})))
  console.log('  account-plan setup:', JSON.stringify(usedPlan.setup ?? usedPlan).slice(0, 300))

  // 4) Flows list shows the new flow.
  const flows = await show('GET /api/flows', await (await import('@/app/api/flows/route')).GET(req('/api/flows')))
  const listed = (flows.flows ?? flows).find?.((f: { id: string }) => f.id === flowId)
  console.log('  new flow listed:', Boolean(listed), '| name:', listed?.name)

  // 5) Builder load.
  const one = await show('GET /api/flows/[id]', await (await import('@/app/api/flows/[id]/route')).GET(req(`/api/flows/${flowId}`)))
  const flowDoc = one.flow ?? one
  console.log('  builder doc: canEdit=', flowDoc.canEdit, 'status=', flowDoc.status, 'nodes=', (flowDoc.graph?.nodes ?? []).length)

  // 6) Run it from the builder.
  const exec = await show('POST /api/flows/[id]/execute', await (await import('@/app/api/flows/[id]/execute/route')).POST(post(`/api/flows/${flowId}/execute`, { input: { text: 'Acme renewed for $120k after support fixed the SSO outage fast.' } })))
  console.log('  execute response:', JSON.stringify(exec).slice(0, 300))
  const runId: string = exec.run?.id ?? exec.flowRunId ?? exec.runId
  if (!runId) throw new Error('no run id from execute')

  // 7) Runs panel: poll the runs route until the run settles.
  const deadline = Date.now() + 120_000
  for (;;) {
    const runs = await (await import('@/app/api/flows/[id]/runs/route')).GET(req(`/api/flows/${flowId}/runs`))
    const body = await runs.json()
    const run = (body.runs ?? body).find?.((r: { id: string }) => r.id === runId) ?? (body.runs ?? body)[0]
    console.log('  poll run:', run?.id, run?.status)
    if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) {
      console.log('  RUN OUTPUT:', JSON.stringify(run.output ?? run.result).slice(0, 300))
      const steps = await prisma.flowRunStep.findMany({ where: { flowRunId: run.id }, orderBy: { order: 'asc' } })
      for (const step of steps) console.log(`  STEP ${step.order} ${step.nodeId} [${step.status}]`, JSON.stringify(step.output)?.slice(0, 140))
      break
    }
    if (Date.now() > deadline) { console.log('  TIMED OUT'); break }
    await new Promise((r) => setTimeout(r, 2_000))
  }

  await seeded.cleanup()
}

test('flows UI contract', { timeout: 240_000 }, async () => {
  await main()
})
