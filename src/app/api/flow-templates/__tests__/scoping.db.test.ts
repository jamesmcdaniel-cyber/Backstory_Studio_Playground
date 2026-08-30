import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The catalogue's tenancy boundary, against a real database: an org sees its
 * own rows at any visibility plus other orgs' PUBLISHED rows, and never another
 * org's private ones. Skipped without TEST_DATABASE_URL; CI provides it.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let fetchFlowTemplateRows: any
  let findFlowTemplate: any
  let listFlowTemplateCatalogue: any
  const ids: Record<string, string> = {}

  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'ask', type: 'ai', data: { aiOp: 'ask', input: 'hi', note: 'n' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'ask' }],
  }

  const mkTemplate = (orgId: string, userId: string, name: string, visibility: string) =>
    prisma.flowTemplate.create({
      data: {
        name,
        category: 'Testing',
        graph,
        trigger: { type: 'manual' },
        // A COMPLETE set of notes, not the minimum zod will parse. serializeFlowTemplate
        // refuses a row whose notes leave an executable node unexplained, and
        // findFlowTemplate turns that refusal into `null` — so a fixture with
        // `steps: []` makes every assertion here read as "not visible" and this
        // file silently stops testing the tenancy boundary it exists for. The
        // one executable node is `ask`; `trigger` is not executable and needs
        // no entry.
        notes: {
          objective: 'o',
          inputs: [],
          steps: [{ nodeId: 'ask', title: 'Ask', what: 'Asks the model a fixed question.' }],
          setup: [],
          customize: [],
        },
        bindings: [],
        configuration: {},
        userId,
        organizationId: orgId,
        visibility,
      },
    })

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ fetchFlowTemplateRows, findFlowTemplate, listFlowTemplateCatalogue } = await import('@/lib/flows/templates/catalogue'))
    const orgA = await prisma.organization.create({ data: { name: 'flowscope A', slug: `flowscope-a-${Date.now()}` } })
    const orgB = await prisma.organization.create({ data: { name: 'flowscope B', slug: `flowscope-b-${Date.now()}` } })
    ids.orgA = orgA.id
    ids.orgB = orgB.id
    const userA = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), email: `ftA-${Date.now()}@example.com`, name: 'A', organizationId: orgA.id } })
    const userB = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), email: `ftB-${Date.now()}@example.com`, name: 'B', organizationId: orgB.id } })
    ids.aOrg = (await mkTemplate(orgA.id, userA.id, 'A-org', 'org')).id
    ids.aGlobal = (await mkTemplate(orgA.id, userA.id, 'A-global', 'global')).id
    ids.bOrg = (await mkTemplate(orgB.id, userB.id, 'B-org', 'org')).id
    ids.bGlobal = (await mkTemplate(orgB.id, userB.id, 'B-global', 'global')).id
  })

  after(async () => {
    if (ids.orgA) await prisma.organization.delete({ where: { id: ids.orgA } }).catch(() => {})
    if (ids.orgB) await prisma.organization.delete({ where: { id: ids.orgB } }).catch(() => {})
  })

  test('an org sees its own rows at any visibility, plus other orgs\' published ones only', async () => {
    const { own, global } = await fetchFlowTemplateRows(ids.orgA)
    assert.deepEqual(own.map((r: any) => r.id).sort(), [ids.aGlobal, ids.aOrg].sort())
    const globalIds = global.map((r: any) => r.id)
    assert.ok(globalIds.includes(ids.bGlobal), 'B\'s published template should be visible to A')
    assert.ok(!globalIds.includes(ids.bOrg), 'B\'s private template must never be visible to A')
    assert.ok(!globalIds.includes(ids.aGlobal), 'own rows must not be duplicated into the community slice')
  })

  test('the catalogue serves stored rows before the built-ins', async () => {
    const catalogue = await listFlowTemplateCatalogue(ids.orgA)
    const firstBuiltin = catalogue.findIndex((entry: any) => entry.source === 'builtin')
    const lastStored = catalogue.map((entry: any) => entry.source).lastIndexOf('user')
    assert.ok(firstBuiltin > lastStored, 'every stored row should precede the built-ins')
    assert.ok(catalogue.some((entry: any) => entry.id === 'churn-risk-scorecard'), 'built-ins should always be present')
  })

  test('fetching one template by id honours the same boundary', async () => {
    assert.ok(await findFlowTemplate(ids.aOrg, ids.orgA), 'own private row is readable')
    assert.ok(await findFlowTemplate(ids.bGlobal, ids.orgA), 'another org\'s published row is readable')
    assert.equal(await findFlowTemplate(ids.bOrg, ids.orgA), null, 'another org\'s private row must not be readable')
  })

  test('a built-in id resolves for any org, with no row behind it', async () => {
    const builtin = await findFlowTemplate('summarize-extract', ids.orgB)
    assert.equal(builtin?.source, 'builtin')
    assert.equal(builtin?.custom, false)
  })
}
