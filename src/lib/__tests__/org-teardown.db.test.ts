/**
 * Org teardown is irreversible and crosses tenant boundaries by construction:
 * it runs on `systemPrisma`, so nothing but the WHERE clauses stands between
 * "delete workspace A" and "delete some of workspace B too". These tests build
 * two fully-populated orgs, tear one down, and assert the survivor is
 * unchanged row-for-row across EVERY org-scoped table in the datamodel — so a
 * table added later is covered the moment it carries an organizationId.
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { Prisma } from '@prisma/client'

const TEST_DB = process.env.TEST_DATABASE_URL
const skip = TEST_DB ? false : 'TEST_DATABASE_URL is not set — org teardown needs a real database'
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
}

let systemPrisma: any
let teardownOrganization: any

before(async () => {
  if (!TEST_DB) return
  ;({ systemPrisma } = await import('@/lib/prisma'))
  ;({ teardownOrganization } = await import('../org-teardown'))
})

/** Every model carrying an organizationId — the exact surface teardown must clear. */
const ORG_MODELS = Prisma.dmmf.datamodel.models.filter((model) =>
  model.fields.some((field) => field.name === 'organizationId'),
)
const delegateName = (model: string) => model.charAt(0).toLowerCase() + model.slice(1)
const hasId = (model: string) =>
  ORG_MODELS.find((m) => m.name === model)!.fields.some((f) => f.name === 'id' && f.kind === 'scalar')

const stable = (value: unknown) =>
  JSON.stringify(value, (_key, raw) => (typeof raw === 'bigint' ? raw.toString() : raw))

/**
 * Columns a BACKGROUND SWEEP owns, excluded from the bystander comparison.
 *
 * The outbox dispatcher polls for `pending` rows across every organization —
 * that is what it is for — so a suite running concurrently against the shared
 * CI database can pick up this fixture's row and stamp its delivery-attempt
 * fields mid-test. That is the dispatcher doing its job, not teardown reaching
 * into another workspace, and the assertion here is specifically about the
 * latter.
 *
 * Deliberately narrow: exactly the columns processOutboxBatch writes, and no
 * others — the claim, the compare-and-set, and both terminal branches together
 * touch these six and nothing else. The row's identity, topic, aggregate,
 * dedupe key, payload, creation time and organization are all still compared
 * byte-for-byte, so a teardown that deleted or rewrote a bystander's outbox row
 * still fails exactly as before.
 *
 * `status` and `deliveredAt` belong here for the same reason the other four do,
 * and their absence was a hole rather than a decision: the claim itself moves a
 * row pending -> processing, so the sweep this list exists to tolerate tripped
 * the assertion on its very first write.
 */
const SWEEP_OWNED: Record<string, string[]> = {
  OutboxEvent: ['attempts', 'availableAt', 'deliveredAt', 'lastError', 'lockedAt', 'status'],
}

async function snapshotOrg(organizationId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const model of ORG_MODELS) {
    const rows = await systemPrisma[delegateName(model.name)].findMany({
      where: { organizationId },
      ...(hasId(model.name) ? { orderBy: { id: 'asc' } } : {}),
    })
    const volatile = SWEEP_OWNED[model.name]
    out[model.name] = stable(
      volatile
        ? (rows as Record<string, unknown>[]).map((row) => {
            const copy = { ...row }
            for (const field of volatile) delete copy[field]
            return copy
          })
        : rows,
    )
  }
  out['Organization'] = stable(await systemPrisma.organization.findUnique({ where: { id: organizationId } }))
  return out
}

async function countsFor(organizationId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const model of ORG_MODELS) {
    out[model.name] = await systemPrisma[delegateName(model.name)].count({ where: { organizationId } })
  }
  return out
}

/** A workspace populated across every area teardown has to walk. */
async function seedPopulatedOrg(label: string) {
  const org = await systemPrisma.organization.create({
    data: { name: `${label}`, slug: `${label}-${crypto.randomUUID()}`, kind: 'customer' },
  })
  const organizationId = org.id
  const user = await systemPrisma.user.create({
    data: {
      supabaseId: crypto.randomUUID(),
      email: `${label}-${crypto.randomUUID()}@example.com`,
      organizationId,
      isActive: true,
      role: 'ADMIN',
    },
  })
  const flow = await systemPrisma.flow.create({ data: { organizationId, userId: user.id, name: `${label}-flow` } })
  await systemPrisma.flowRun.create({ data: { organizationId, flowId: flow.id, status: 'SUCCESS' } })
  await systemPrisma.flowVersion.create({
    data: { organizationId, flowId: flow.id, version: 1, graph: {}, trigger: {}, publishedBy: user.id },
  })
  await systemPrisma.agentTask.create({
    data: { organizationId, userId: user.id, description: 'd', objective: 'o' },
  })
  await systemPrisma.agentExecution.create({
    data: { organizationId, userId: user.id, agentType: 'research', input: {}, trigger: {} },
  })
  await systemPrisma.agentTemplate.create({
    data: { organizationId, userId: user.id, name: `${label}-tpl`, type: 'Custom', configuration: {} },
  })
  await systemPrisma.flowTemplate.create({
    data: { organizationId, userId: user.id, name: `${label}-ftpl`, graph: {} },
  })
  await systemPrisma.sharedSkill.create({
    data: { organizationId, userId: user.id, name: `${label}-skill`, instructions: 'do it' },
  })
  await systemPrisma.integration.create({ data: { organizationId, userId: user.id, provider: 'slack' } })
  await systemPrisma.mcpConnection.create({
    data: { organizationId, userId: user.id, name: 'mcp', serverUrl: 'https://example.com/mcp' },
  })
  await systemPrisma.nangoConnection.create({
    data: {
      organizationId,
      userId: user.id,
      connectionId: `conn-${crypto.randomUUID()}`,
      providerConfigKey: 'slack',
      status: 'connected',
    },
  })
  await systemPrisma.apiKey.create({
    data: { organizationId, userId: user.id, name: 'k', keyHash: crypto.randomUUID(), prefix: `bs_${label}` },
  })
  await systemPrisma.httpCredential.create({
    data: {
      organizationId,
      name: 'cred',
      authType: 'bearer',
      allowedHost: 'api.example.com',
      secretConfig: 'encrypted-blob',
    },
  })
  const storedFile = await systemPrisma.storedFile.create({
    data: { organizationId, userId: user.id, filename: 'a.txt', size: 12, backend: 'db' },
  })
  await systemPrisma.knowledgeDocument.create({
    data: { organizationId, userId: user.id, filename: 'kb.md', mimeType: 'text/markdown' },
  })
  await systemPrisma.auditEvent.create({ data: { organizationId, action: 'test.event' } })
  await systemPrisma.notification.create({ data: { organizationId, userId: user.id, type: 't', title: 'hi' } })
  await systemPrisma.team.create({ data: { organizationId, name: `${label}-team` } })
  await systemPrisma.workspaceFolder.create({ data: { organizationId, name: `${label}-folder` } })
  await systemPrisma.invitation.create({
    data: {
      organizationId,
      email: `invitee-${crypto.randomUUID()}@example.com`,
      tokenHash: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  })
  await systemPrisma.outboxEvent.create({ data: { organizationId, topic: 'x', payload: {} } })
  await systemPrisma.catalogueSubmission.create({
    data: {
      organizationId,
      submittedByUserId: user.id,
      kind: 'shared_skill',
      title: 't',
      summary: 's',
      snapshot: {},
    },
  })
  return { organizationId, userId: user.id, flowId: flow.id, storedFileId: storedFile.id }
}

const dropOrg = async (organizationId: string) => {
  await systemPrisma.user
    .updateMany({ where: { organizationId }, data: { organizationId: null } })
    .catch(() => {})
  await systemPrisma.organization.delete({ where: { id: organizationId } }).catch(() => {})
}

test('teardown deletes every row the target org owns, across every org-scoped table', { skip }, async () => {
  const a = await seedPopulatedOrg('teardown-a')
  try {
    const before = await countsFor(a.organizationId)
    // The fixture must actually exercise a meaningful slice, or "all zero
    // afterwards" would prove nothing.
    const populated = Object.entries(before).filter(([, count]) => count > 0)
    assert.ok(populated.length >= 20, `fixture only populated ${populated.length} tables`)

    const result = await teardownOrganization(a.organizationId)

    assert.deepEqual(result, { nango: 0, graphCleared: false, filesDeleted: 1 })
    const after = await countsFor(a.organizationId)
    const leftovers = Object.entries(after).filter(([, count]) => count > 0)
    assert.deepEqual(leftovers, [], 'teardown left orphaned rows behind')
    assert.equal(await systemPrisma.organization.count({ where: { id: a.organizationId } }), 0)
  } finally {
    await dropOrg(a.organizationId)
  }
})

test('teardown deletes the object-store blobs before their metadata rows', { skip }, async () => {
  const a = await seedPopulatedOrg('teardown-files')
  try {
    await systemPrisma.storedFile.create({
      data: { organizationId: a.organizationId, filename: 'b.txt', size: 3, backend: 'db' },
    })

    const result = await teardownOrganization(a.organizationId)

    assert.equal(result.filesDeleted, 2, 'every stored file is accounted for, not just the first')
    assert.equal(await systemPrisma.storedFile.count({ where: { organizationId: a.organizationId } }), 0)
  } finally {
    await dropOrg(a.organizationId)
  }
})

test('teardown NEVER touches another workspace — row-for-row', { skip }, async () => {
  const a = await seedPopulatedOrg('teardown-victim')
  const b = await seedPopulatedOrg('teardown-bystander')
  try {
    const before = await snapshotOrg(b.organizationId)

    await teardownOrganization(a.organizationId)

    const after = await snapshotOrg(b.organizationId)
    for (const model of Object.keys(before)) {
      assert.equal(after[model], before[model], `${model} rows changed in the bystander workspace`)
    }
    // And the survivor is still coherent, not merely present: its user, flow
    // and file rows still resolve by id.
    assert.ok(await systemPrisma.user.findUnique({ where: { id: b.userId } }))
    assert.ok(await systemPrisma.flow.findUnique({ where: { id: b.flowId } }))
    assert.ok(await systemPrisma.storedFile.findUnique({ where: { id: b.storedFileId } }))
  } finally {
    await dropOrg(a.organizationId)
    await dropOrg(b.organizationId)
  }
})

test('teardown detaches the platform owner instead of deleting them', { skip }, async () => {
  // The users-table trigger refuses to delete an owner row, which would abort
  // the whole cascade; the owner must survive with no workspace.
  const a = await seedPopulatedOrg('teardown-owner')
  let ownerId: string | null = null
  try {
    const owner = await systemPrisma.user.create({
      data: {
        supabaseId: crypto.randomUUID(),
        email: 'James.McDaniel@People.ai', // mixed case on purpose: the match is insensitive
        organizationId: a.organizationId,
        isActive: true,
      },
    })
    ownerId = owner.id

    await teardownOrganization(a.organizationId)

    const survivor = await systemPrisma.user.findUnique({ where: { id: owner.id } })
    assert.ok(survivor, 'the platform owner account must survive workspace deletion')
    assert.equal(survivor.organizationId, null, 'and be detached so sign-in re-provisions them')
    assert.equal(await systemPrisma.organization.count({ where: { id: a.organizationId } }), 0)
  } finally {
    if (ownerId) await systemPrisma.user.update({ where: { id: ownerId }, data: { organizationId: null } }).catch(() => {})
    await dropOrg(a.organizationId)
  }
})

test('an external-deletion failure aborts BEFORE anything is deleted (fail closed)', { skip }, async () => {
  // Teardown promises erasure. If a processor still holds a copy the database
  // delete must not happen, or we would report erasure that did not occur.
  const a = await seedPopulatedOrg('teardown-failclosed')
  const restore = {
    uri: process.env.NEO4J_URI,
    user: process.env.NEO4J_USERNAME,
    pass: process.env.NEO4J_PASSWORD,
  }
  try {
    process.env.NEO4J_URI = 'bogus-scheme://neo4j.invalid:7687'
    process.env.NEO4J_USERNAME = 'neo4j'
    process.env.NEO4J_PASSWORD = 'nope'
    const before = await countsFor(a.organizationId)

    await assert.rejects(
      () => teardownOrganization(a.organizationId),
      (error: any) => {
        assert.ok(error instanceof AggregateError, `expected AggregateError, got ${error?.name}`)
        assert.match(error.message, /was not committed/)
        return true
      },
    )

    const after = await countsFor(a.organizationId)
    assert.deepEqual(after, before, 'a failed external leg must leave the database exactly as it was')
    assert.equal(await systemPrisma.organization.count({ where: { id: a.organizationId } }), 1)
  } finally {
    process.env.NEO4J_URI = restore.uri
    process.env.NEO4J_USERNAME = restore.user
    process.env.NEO4J_PASSWORD = restore.pass
    if (!restore.uri) delete process.env.NEO4J_URI
    if (!restore.user) delete process.env.NEO4J_USERNAME
    if (!restore.pass) delete process.env.NEO4J_PASSWORD
    await dropOrg(a.organizationId)
  }
})

test('a retry after a failed teardown succeeds', { skip }, async () => {
  // The failure above is documented as safe to retry — prove it, since the
  // first attempt already deleted external state before it threw.
  const a = await seedPopulatedOrg('teardown-retry')
  try {
    process.env.NEO4J_URI = 'bogus-scheme://neo4j.invalid:7687'
    process.env.NEO4J_USERNAME = 'neo4j'
    process.env.NEO4J_PASSWORD = 'nope'
    await assert.rejects(() => teardownOrganization(a.organizationId))
    delete process.env.NEO4J_URI
    delete process.env.NEO4J_USERNAME
    delete process.env.NEO4J_PASSWORD

    const result = await teardownOrganization(a.organizationId)

    assert.equal(result.filesDeleted, 1)
    assert.equal(await systemPrisma.organization.count({ where: { id: a.organizationId } }), 0)
  } finally {
    delete process.env.NEO4J_URI
    delete process.env.NEO4J_USERNAME
    delete process.env.NEO4J_PASSWORD
    await dropOrg(a.organizationId)
  }
})

test('running teardown twice fails loudly rather than silently succeeding', { skip }, async () => {
  // Documented behaviour, pinned deliberately: the second call has nothing to
  // delete and Prisma raises P2025. A caller that retries a completed teardown
  // must not mistake that for a fresh erasure.
  const a = await seedPopulatedOrg('teardown-twice')
  try {
    await teardownOrganization(a.organizationId)

    await assert.rejects(
      () => teardownOrganization(a.organizationId),
      (error: any) => {
        assert.equal(error.code, 'P2025', `expected a not-found delete, got ${error?.code ?? error?.message}`)
        return true
      },
    )
  } finally {
    await dropOrg(a.organizationId)
  }
})
