/**
 * Publishing is the one-way door that turns a single workspace's row into a
 * PUBLIC catalogue entry every other workspace can read and run. These tests
 * drive the real path — author row → submission snapshot → published entry —
 * against a database, and assert the two things that matter: the public record
 * carries none of the author's tenant identifiers or literal credentials, and
 * the entry lands in the internal org owned by the approving reviewer.
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
const skip = TEST_DB ? false : 'TEST_DATABASE_URL is not set — catalogue publishing needs a real database'
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
}

let systemPrisma: any
let publishSubmission: any
let resolveInternalOrgId: any
let createSubmission: any

before(async () => {
  if (!TEST_DB) return
  ;({ systemPrisma } = await import('@/lib/prisma'))
  ;({ publishSubmission, resolveInternalOrgId } = await import('../publish'))
  ;({ createSubmission } = await import('../submissions'))
})

/**
 * Internal fixtures are dated FAR FUTURE on purpose. `resolveInternalOrgId`
 * picks the OLDEST internal org, and CI runs every DB test file against one
 * shared database — a normally-dated internal fixture here would silently
 * become "the platform" for whichever other file is running at the time.
 * Only the ordering test below deliberately dates one into the past.
 */
const INTERNAL_FIXTURE_DATE = new Date('2099-01-01')

async function seedOrg(kind: string, createdAt?: Date) {
  const org = await systemPrisma.organization.create({
    data: {
      name: `pub-${kind}`,
      slug: `pub-${crypto.randomUUID()}`,
      kind,
      ...(createdAt ? { createdAt } : {}),
    },
  })
  const user = await systemPrisma.user.create({
    data: {
      supabaseId: crypto.randomUUID(),
      email: `pub-${crypto.randomUUID()}@example.com`,
      organizationId: org.id,
      isActive: true,
      role: 'ADMIN',
    },
  })
  return { organizationId: org.id, userId: user.id }
}

const dropOrg = async (organizationId: string) => {
  await systemPrisma.user.updateMany({ where: { organizationId }, data: { organizationId: null } }).catch(() => {})
  await systemPrisma.organization.delete({ where: { id: organizationId } }).catch(() => {})
}

/** A graph shaped like a real one, carrying exactly the things that must not escape. */
const authoredGraph = (authorOrgId: string, authorUserId: string) => ({
  nodes: [
    { id: 'n1', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: { type: 'manual' } } },
    {
      id: 'n2',
      type: 'action',
      position: { x: 0, y: 120 },
      data: {
        label: 'Call the API',
        url: 'https://api.example.com/v1/items',
        credentialId: 'cred_author_only',
        connectionId: 'nango-conn-42',
        organizationId: authorOrgId,
        userId: authorUserId,
        headers: { Authorization: 'Bearer sk-ant-abcdefghijklmnop0123456789' },
      },
    },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
})

test('resolveInternalOrgId picks the OLDEST internal org and never a customer one', { skip }, async () => {
  const customer = await seedOrg('customer', new Date('1999-01-01'))
  const older = await seedOrg('internal', new Date('2000-01-01'))
  const newer = await seedOrg('internal', new Date('2020-01-01'))
  try {
    const resolved = await resolveInternalOrgId()

    assert.equal(resolved, older.organizationId)
    assert.notEqual(resolved, newer.organizationId)
    assert.notEqual(resolved, customer.organizationId)
  } finally {
    await dropOrg(customer.organizationId)
    await dropOrg(older.organizationId)
    await dropOrg(newer.organizationId)
  }
})

test('resolveInternalOrgId fails loudly rather than publishing into a customer workspace', { skip }, async (t) => {
  // A silent fallback here would publish a global entry into whichever org
  // happened to be first — the comment in the module says so, pin it.
  const customer = await seedOrg('customer')
  try {
    // The only assertion that cannot be scoped to this file's fixtures: it is
    // about the ABSENCE of internal orgs. On the shared CI database another
    // file may hold one, in which case say so out loud rather than assert
    // something this test cannot control.
    if ((await systemPrisma.organization.count({ where: { kind: 'internal' } })) > 0) {
      t.skip('another test file holds an internal org fixture in this shared database')
      return
    }

    await assert.rejects(() => resolveInternalOrgId(), /No internal organization exists/)
  } finally {
    await dropOrg(customer.organizationId)
  }
})

test('a published agent template is owned by the internal org and the approving reviewer', { skip }, async () => {
  const author = await seedOrg('customer')
  const internal = await seedOrg('internal', INTERNAL_FIXTURE_DATE)
  try {
    const source = await systemPrisma.agentTemplate.create({
      data: {
        organizationId: author.organizationId,
        userId: author.userId,
        name: 'Renewal researcher',
        description: 'Researches renewals',
        type: 'Research',
        configuration: { instructions: 'go', credentialId: 'cred_author_only', authorName: 'Ada' },
      },
    })
    const submission = await createSubmission({
      organizationId: author.organizationId,
      userId: author.userId,
      kind: 'agent_template',
      sourceId: source.id,
      title: 'Renewal researcher',
      summary: 'useful',
    })

    const { publishedEntryId } = await publishSubmission({
      submissionId: submission.id,
      reviewerUserId: internal.userId,
      internalOrgId: internal.organizationId,
    })

    const entry = await systemPrisma.agentTemplate.findUnique({ where: { id: publishedEntryId } })
    assert.equal(entry.organizationId, internal.organizationId, 'the entry lives in the internal org')
    assert.equal(entry.userId, internal.userId, 'the approving reviewer owns it — they are accountable')
    assert.equal(entry.visibility, 'global')
    assert.equal(entry.catalogueStatus, 'published')
    assert.equal(entry.name, 'Renewal researcher')
    assert.equal(entry.type, 'Research', 'the snapshot type becomes the catalogue category')
    // The author's own row is untouched and stays private to them.
    const original = await systemPrisma.agentTemplate.findUnique({ where: { id: source.id } })
    assert.equal(original.visibility, 'org')
    assert.equal(original.organizationId, author.organizationId)
  } finally {
    await dropOrg(author.organizationId)
    await dropOrg(internal.organizationId)
  }
})

test('the published record carries NO tenant identifiers from the author workspace', { skip }, async () => {
  const author = await seedOrg('customer')
  const internal = await seedOrg('internal', INTERNAL_FIXTURE_DATE)
  try {
    const source = await systemPrisma.flowTemplate.create({
      data: {
        organizationId: author.organizationId,
        userId: author.userId,
        name: 'Weekly digest',
        description: 'Sends a digest',
        category: 'Reporting',
        graph: authoredGraph(author.organizationId, author.userId),
        configuration: { integrations: ['slack'], tags: ['digest'], authorName: 'Ada', icon: '📮' },
      },
    })
    const submission = await createSubmission({
      organizationId: author.organizationId,
      userId: author.userId,
      kind: 'flow_template',
      sourceId: source.id,
      title: 'Weekly digest',
      summary: 'useful',
    })

    const { publishedEntryId } = await publishSubmission({
      submissionId: submission.id,
      reviewerUserId: internal.userId,
      internalOrgId: internal.organizationId,
    })

    const entry = await systemPrisma.flowTemplate.findUnique({ where: { id: publishedEntryId } })
    const publicBytes = JSON.stringify({ ...entry, id: null, organizationId: null, userId: null })
    assert.ok(!publicBytes.includes(author.organizationId), 'the author org id leaked into the public entry')
    assert.ok(!publicBytes.includes(author.userId), 'the author user id leaked into the public entry')
    assert.ok(!publicBytes.includes('cred_author_only'), 'a workspace-local credential id leaked')
    assert.ok(!publicBytes.includes('nango-conn-42'), 'a workspace-local connection id leaked')
    // Functional content survives — a catalogue entry that lost its steps is
    // worthless, which is why this boundary strips ids rather than blanking.
    const node = (entry.graph as any).nodes.find((n: any) => n.id === 'n2')
    assert.equal(node.data.url, 'https://api.example.com/v1/items')
    assert.equal(entry.category, 'Reporting')
    assert.deepEqual((entry.configuration as any).tags, ['digest'])
    assert.equal((entry.configuration as any).authorName, 'Ada', 'attribution rides in configuration')
    assert.equal(entry.visibility, 'global')
    assert.equal(entry.catalogueStatus, 'published')
    assert.equal((entry.trigger as any).type, 'manual', 'the trigger is derived from the graph, never carried')
    // Regression: FlowTemplate.notes is nullable and the snapshot drops null
    // fields, so publishing a notes-less template used to throw "undefined is
    // not valid JSON" inside createFlowTemplate and no such submission could
    // ever be published.
    assert.deepEqual(entry.notes, {}, 'a notes-less source must still publish')
  } finally {
    await dropOrg(author.organizationId)
    await dropOrg(internal.organizationId)
  }
})

test('a literal credential is REPORTED to the reviewer, not silently published-or-stripped', { skip }, async () => {
  // Stripping a token would quietly break the template; the reviewer decides.
  // What must be true either way is that the reviewer sees a warning.
  const author = await seedOrg('customer')
  const internal = await seedOrg('internal', INTERNAL_FIXTURE_DATE)
  try {
    const source = await systemPrisma.flowTemplate.create({
      data: {
        organizationId: author.organizationId,
        userId: author.userId,
        name: 'Leaky',
        description: '',
        category: 'Custom',
        graph: authoredGraph(author.organizationId, author.userId),
      },
    })
    const submission = await createSubmission({
      organizationId: author.organizationId,
      userId: author.userId,
      kind: 'flow_template',
      sourceId: source.id,
      title: 'Leaky',
      summary: 'has a token',
    })

    const warnings = submission.warnings as any[]
    assert.ok(Array.isArray(warnings) && warnings.length > 0, 'the submit-time scan must flag the literal token')
    assert.ok(
      warnings.some((w) => /Bearer|Anthropic/i.test(w.reason)),
      `expected a credential finding, got ${JSON.stringify(warnings)}`,
    )
    assert.ok(
      !JSON.stringify(warnings).includes('abcdefghijklmnop0123456789'),
      'the warning must mask the secret it reports',
    )

    const { publishedEntryId } = await publishSubmission({
      submissionId: submission.id,
      reviewerUserId: internal.userId,
      internalOrgId: internal.organizationId,
    })
    const entry = await systemPrisma.flowTemplate.findUnique({ where: { id: publishedEntryId } })
    // Documented behaviour: approval publishes what was reviewed, warnings and
    // all. The gate is the human, not this function.
    assert.ok(JSON.stringify(entry.graph).includes('Bearer sk-ant-'), 'publish must not silently rewrite the graph')
  } finally {
    await dropOrg(author.organizationId)
    await dropOrg(internal.organizationId)
  }
})

test('a published shared skill is a global row in the internal org', { skip }, async () => {
  const author = await seedOrg('customer')
  const internal = await seedOrg('internal', INTERNAL_FIXTURE_DATE)
  try {
    const source = await systemPrisma.sharedSkill.create({
      data: {
        organizationId: author.organizationId,
        userId: author.userId,
        name: 'Summarize calls',
        description: 'd',
        category: 'Sales',
        instructions: 'Summarize the call',
        tags: ['sales'],
        integrations: ['gong'],
        authorName: 'Ada',
      },
    })
    const submission = await createSubmission({
      organizationId: author.organizationId,
      userId: author.userId,
      kind: 'shared_skill',
      sourceId: source.id,
      title: 'Summarize calls',
      summary: 'useful',
    })

    const { publishedEntryId } = await publishSubmission({
      submissionId: submission.id,
      reviewerUserId: internal.userId,
      internalOrgId: internal.organizationId,
    })

    const entry = await systemPrisma.sharedSkill.findUnique({ where: { id: publishedEntryId } })
    assert.equal(entry.organizationId, internal.organizationId)
    assert.equal(entry.userId, internal.userId)
    assert.equal(entry.visibility, 'global')
    assert.equal(entry.catalogueStatus, 'published')
    assert.equal(entry.instructions, 'Summarize the call')
    assert.deepEqual(entry.tags, ['sales'])
    assert.equal(entry.authorName, 'Ada')
    assert.equal(
      await systemPrisma.sharedSkill.count({ where: { organizationId: author.organizationId } }),
      1,
      'nothing extra appears in the author workspace',
    )
  } finally {
    await dropOrg(author.organizationId)
    await dropOrg(internal.organizationId)
  }
})

test('publishing an unknown submission throws instead of creating an empty entry', { skip }, async () => {
  const internal = await seedOrg('internal', INTERNAL_FIXTURE_DATE)
  try {
    const beforeAgents = await systemPrisma.agentTemplate.count()
    const beforeSkills = await systemPrisma.sharedSkill.count()

    await assert.rejects(
      () =>
        publishSubmission({
          submissionId: 'does-not-exist',
          reviewerUserId: internal.userId,
          internalOrgId: internal.organizationId,
        }),
      /no longer exists/,
    )

    assert.equal(await systemPrisma.agentTemplate.count(), beforeAgents)
    assert.equal(await systemPrisma.sharedSkill.count(), beforeSkills)
  } finally {
    await dropOrg(internal.organizationId)
  }
})

test('publishSubmission is NOT idempotent — the pending-claim is the only guard', { skip }, async () => {
  // Pinned deliberately. Double-publish protection lives in the review route's
  // conditional `updateMany({ where: { status: 'pending' } })`; calling this
  // function twice really does create two catalogue rows. Any future caller
  // that skips the claim would duplicate entries, and this test says so.
  const author = await seedOrg('customer')
  const internal = await seedOrg('internal', INTERNAL_FIXTURE_DATE)
  try {
    const source = await systemPrisma.sharedSkill.create({
      data: {
        organizationId: author.organizationId,
        userId: author.userId,
        name: 'Dup',
        instructions: 'x',
      },
    })
    const submission = await createSubmission({
      organizationId: author.organizationId,
      userId: author.userId,
      kind: 'shared_skill',
      sourceId: source.id,
      title: 'Dup',
      summary: 's',
    })
    const params = {
      submissionId: submission.id,
      reviewerUserId: internal.userId,
      internalOrgId: internal.organizationId,
    }

    const first = await publishSubmission(params)
    const second = await publishSubmission(params)

    assert.notEqual(first.publishedEntryId, second.publishedEntryId)
    assert.equal(
      await systemPrisma.sharedSkill.count({ where: { organizationId: internal.organizationId } }),
      2,
      'two calls publish two entries — the caller must claim the submission first',
    )
    // And publishing does not itself move the submission's review state: the
    // route owns that transition.
    const after = await systemPrisma.catalogueSubmission.findUnique({ where: { id: submission.id } })
    assert.equal(after.status, 'pending')
    assert.equal(after.publishedEntryId, null)
  } finally {
    await dropOrg(author.organizationId)
    await dropOrg(internal.organizationId)
  }
})

test('publishing survives the author deleting their source row', { skip }, async () => {
  // The snapshot is authoritative — that is the whole reason it is frozen.
  const author = await seedOrg('customer')
  const internal = await seedOrg('internal', INTERNAL_FIXTURE_DATE)
  try {
    const source = await systemPrisma.agentTemplate.create({
      data: {
        organizationId: author.organizationId,
        userId: author.userId,
        name: 'Ephemeral',
        type: 'Custom',
        configuration: { instructions: 'reviewed bytes' },
      },
    })
    const submission = await createSubmission({
      organizationId: author.organizationId,
      userId: author.userId,
      kind: 'agent_template',
      sourceId: source.id,
      title: 'Ephemeral',
      summary: 's',
    })
    await systemPrisma.agentTemplate.delete({ where: { id: source.id } })

    const { publishedEntryId } = await publishSubmission({
      submissionId: submission.id,
      reviewerUserId: internal.userId,
      internalOrgId: internal.organizationId,
    })

    const entry = await systemPrisma.agentTemplate.findUnique({ where: { id: publishedEntryId } })
    assert.equal((entry.configuration as any).instructions, 'reviewed bytes')
  } finally {
    await dropOrg(author.organizationId)
    await dropOrg(internal.organizationId)
  }
})
