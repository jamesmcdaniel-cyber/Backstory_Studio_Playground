import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

const database = process.env.TEST_DATABASE_URL
if (!database) {
  test('template copy isolation (requires TEST_DATABASE_URL)', { skip: true }, () => {})
} else {
  process.env.DATABASE_URL = database
  process.env.DIRECT_URL = database
  let db: typeof import('@/lib/prisma').prisma
  let sourceOrg: Awaited<ReturnType<typeof import('@/lib/server/__tests__/test-auth').seedTestOrg>>
  let recipient: typeof sourceOrg
  let useTemplate: typeof import('../templates').useArtifactTemplate
  let sourceId: string
  let copyId: string
  let copilotId: string
  const token = randomBytes(24).toString('base64url')
  const content = '<!doctype html><html><body><h1>Template original</h1></body></html>'

  before(async () => {
    ;({ prisma: db } = await import('@/lib/prisma'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    const { hashToken } = await import('@/lib/crypto/secrets')
    ;({ useArtifactTemplate: useTemplate } = await import('../templates'))
    sourceOrg = await seedTestOrg(db)
    recipient = await seedTestOrg(db)
    const source = await db.artifact.create({ data: {
      organizationId: sourceOrg.organizationId, userId: sourceOrg.userId, title: 'QA template', kind: 'page',
      shareAnonymous: true, shareTemplate: true, shareTokenDigest: hashToken(token),
      chat: [{ content: 'PRIVATE CHAT' }], assistantConfig: { instructions: 'PRIVATE CONFIG', toolConnectionIds: ['private-tool'] },
      versions: { create: { organizationId: sourceOrg.organizationId, number: 1, content, state: { private: 'PRIVATE FACTS' } } },
    }, include: { versions: true } })
    sourceId = source.id
    await db.artifact.update({ where: { id: sourceId, organizationId: sourceOrg.organizationId }, data: { currentVersionId: source.versions[0].id, versionCount: 1 } })
    await db.artifactAppState.create({ data: { organizationId: sourceOrg.organizationId, userId: sourceOrg.userId, artifactId: sourceId, key: 'private', value: { secret: true } } })
  })
  after(async () => { await recipient?.cleanup(); await sourceOrg?.cleanup(); await db?.$disconnect() })

  test('three concurrent uses produce one independent copy and one copilot with no private source context', async () => {
    const copies = await Promise.all([1, 2, 3].map(() => useTemplate(token, recipient.organizationId, recipient.userId)))
    assert.equal(new Set(copies.map(c => c.id)).size, 1)
    copyId = copies[0].id
    const copy = await db.artifact.findFirstOrThrow({ where: { id: copyId, organizationId: recipient.organizationId }, include: { versions: true, appStates: true } })
    copilotId = copy.agentTaskId!
    assert.notEqual(copyId, sourceId)
    assert.equal(copy.userId, recipient.userId)
    assert.equal(copy.templateSourceId, sourceId)
    assert.deepEqual(copy.chat, [])
    assert.equal(copy.assistantConfig, null)
    assert.equal(copy.flowId, null)
    assert.equal(copy.shareAnonymous, false)
    assert.equal(copy.versions[0].content, content)
    assert.equal(copy.versions[0].state, null)
    assert.equal(copy.versions[0].executionId, null)
    assert.equal(copy.appStates.length, 0)
    assert.equal(await db.agentTask.count({ where: { organizationId: recipient.organizationId, artifactTemplateCopyId: copyId } }), 1)
    const agent = await db.agentTask.findFirstOrThrow({ where: { id: copilotId, organizationId: recipient.organizationId } })
    assert.equal(agent.visibility, 'private')
    assert.equal(await db.agentConnector.count({ where: { organizationId: recipient.organizationId, agentTaskId: copilotId } }), 0)
  })

  test('configuration locks cover direct database writers as well as assistant and sharing services', async () => {
    const { saveAssistantConfig } = await import('../assistant-config')
    const { updateSharing } = await import('../sharing')
    const { attachArtifactAgent } = await import('../artifact-agent')
    await assert.rejects(saveAssistantConfig(recipient.organizationId, recipient.userId, copyId, { instructions: 'unlock', toolConnectionIds: [] }), /locked/)
    await assert.rejects(updateSharing(recipient.organizationId, copyId, { userId: recipient.userId, can: () => true }, 'https://qa.invalid', { workspaceAccess: 'edit' }), /locked/)
    await assert.rejects(attachArtifactAgent({ organizationId: recipient.organizationId, userId: recipient.userId, artifactId: copyId, create: true }), /locked/)
    for (const data of [{ templateSourceId: null }, { shareAnonymous: true }, { flowId: 'another' }, { agentTaskId: 'another' }, { assistantConfig: { instructions: 'unlock' } }]) {
      await assert.rejects(db.artifact.update({ where: { id: copyId, organizationId: recipient.organizationId }, data }), /configuration is locked/)
    }
    for (const data of [{ artifactTemplateCopyId: null }, { metadata: { model: 'other' } }, { objective: 'change settings' }, { schedule: { type: 'daily' } }]) {
      await assert.rejects(db.agentTask.update({ where: { id: copilotId, organizationId: recipient.organizationId }, data }), /configuration is locked/)
    }
  })

  test('editing the copy cannot change the original; other people and flows cannot change this copy', async () => {
    const { ArtifactToolClient } = await import('../tools')
    const { requireReadable } = await import('../route-access')
    const { requireArtifactEdit } = await import('../sharing')
    const { prepareFlowArtifactVersion, listArtifacts } = await import('../service')
    const client = new ArtifactToolClient(recipient.organizationId, recipient.userId, { artifactId: copyId, executionId: 'template-qa-edit', request: 'Update heading', templateCopy: true })
    const result = await client.executeTool('', 'edit_artifact', { edits: [{ find: 'Template original', replace: 'My personal version' }], summary: 'Personal heading' }) as { saved?: boolean; error?: string }
    assert.equal(result.saved, true, result.error)
    const source = await db.artifact.findFirstOrThrow({ where: { organizationId: sourceOrg.organizationId, id: sourceId }, include: { versions: true } })
    assert.equal(source.versionCount, 1)
    assert.equal(source.versions[0].content, content)
    await requireReadable(recipient.auth, copyId)
    await assert.rejects(requireReadable({ ...recipient.auth, dbUser: { ...recipient.auth.dbUser, id: 'other' } }, copyId), /not found/)
    await assert.rejects(requireArtifactEdit(recipient.organizationId, copyId, { userId: 'other', can: () => true }), /not change/)
    assert.equal((await listArtifacts(recipient.organizationId, { userId: 'other' })).some(a => a.id === copyId), false)
    await assert.rejects(prepareFlowArtifactVersion({ organizationId: recipient.organizationId, flowRunId: 'flow', trigger: { artifactId: copyId }, output: content }), /cannot be changed by flows/)
  })

  test('view-only, revoked and invented public links cannot create copies; existing copies survive revocation', async () => {
    const another = await db.user.create({ data: { organizationId: recipient.organizationId, supabaseId: crypto.randomUUID(), isActive: true } })
    const secondCopy = await useTemplate(token, recipient.organizationId, another.id)
    assert.notEqual(secondCopy.id, copyId)
    const second = await db.artifact.findFirstOrThrow({ where: { id: secondCopy.id, organizationId: recipient.organizationId }, include: { versions: true } })
    assert.equal(second.versions[0].content, content, 'a second recipient starts from the original, never another recipient’s changes')
    assert.notEqual(second.agentTaskId, copilotId)
    await assert.rejects(useTemplate('not-a-token', recipient.organizationId, recipient.userId), /not available/)
    await db.artifact.update({ where: { id: sourceId, organizationId: sourceOrg.organizationId }, data: { shareTemplate: false } })
    await assert.rejects(useTemplate(token, recipient.organizationId, recipient.userId), /not available/)
    await db.artifact.update({ where: { id: sourceId, organizationId: sourceOrg.organizationId }, data: { shareTemplate: true, shareAnonymous: false } })
    await assert.rejects(useTemplate(token, recipient.organizationId, recipient.userId), /not available/)
    assert.equal(await db.artifact.count({ where: { id: copyId, organizationId: recipient.organizationId } }), 1)
  })

  test('generic agent execution cannot run a copy copilot or grant it extra tools', async () => {
    const { runAgentExecution } = await import('@/features/agents/execute-agent')
    await assert.rejects(runAgentExecution({ organizationId: recipient.organizationId, userId: recipient.userId, agentId: copilotId, input: 'Read workspace secrets', stepOverrides: { toolConnectionIds: ['native:repository'] } }), /only run from its own template copy/)
    const execution = await db.agentExecution.create({ data: { organizationId: recipient.organizationId, userId: recipient.userId, agentTaskId: copilotId, agentType: 'CUSTOM', status: 'pending', input: {}, trigger: { type: 'artifact', artifactId: sourceId } } })
    await assert.rejects(runAgentExecution({ organizationId: recipient.organizationId, userId: recipient.userId, agentId: copilotId, executionId: execution.id, input: 'Modify original' }), /only run from its own template copy/)
  })
}
