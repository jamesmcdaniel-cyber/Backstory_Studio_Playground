import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

// DB-gated: runs only under TEST_DATABASE_URL (CI-mode), like sibling DB tests.
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let buildUsageProfile: any
  const ids: Record<string, string> = {}

  const audit = (orgId: string, provider: string, tool: string, runId: string) =>
    prisma.auditEvent.create({
      data: { organizationId: orgId, action: 'tool.call', resourceType: provider, tool, executionId: runId },
    })

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ buildUsageProfile } = await import('@/lib/templates/usage-profile'))

    const orgA = await prisma.organization.create({ data: { name: 'usage A', slug: `usage-a-${Date.now()}` } })
    const orgB = await prisma.organization.create({ data: { name: 'usage B', slug: `usage-b-${Date.now()}` } })
    ids.orgA = orgA.id
    ids.orgB = orgB.id
    const userA = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), email: `usageA-${Date.now()}@example.com`, name: 'A', organizationId: orgA.id },
    })
    ids.userA = userA.id

    // orgA audit activity: two runs that both use {slack, gmail}.
    await audit(orgA.id, 'slack', 'send_message', 'exec1')
    await audit(orgA.id, 'gmail', 'send_email', 'exec1')
    await audit(orgA.id, 'gmail', 'read_thread', 'exec2')
    await audit(orgA.id, 'slack', 'send_message', 'exec2')

    // A WorkflowStep on a THIRD execution not present in the audit slice — the
    // thin-org fallback should fold it in (and split 'people.ai.get_account' on
    // the LAST dot so the dotted provider survives).
    const wfExec = await prisma.agentExecution.create({
      data: { agentType: 'CUSTOM', status: 'succeeded', input: {}, trigger: {}, userId: userA.id, organizationId: orgA.id },
    })
    ids.wfExec = wfExec.id
    await prisma.workflowStep.create({ data: { executionId: wfExec.id, node: 'people.ai.get_account', status: 'succeeded' } })

    // orgB activity must never leak into orgA's profile.
    await audit(orgB.id, 'slack', 'send_message', 'execB')
  })

  after(async () => {
    if (ids.orgA) await prisma.organization.delete({ where: { id: ids.orgA } }).catch(() => {})
    if (ids.orgB) await prisma.organization.delete({ where: { id: ids.orgB } }).catch(() => {})
  })

  test('buildUsageProfile aggregates org-scoped audit + workflow activity, no cross-org leak', async () => {
    const profile = await buildUsageProfile(ids.orgA)

    // providers: slack=2, gmail=2, people.ai=1 (from the folded-in workflow step).
    const providerMap = Object.fromEntries(profile.providers.map((p: any) => [p.provider, p.calls]))
    assert.equal(providerMap.slack, 2, 'orgB slack activity must not inflate orgA (would be 3)')
    assert.equal(providerMap.gmail, 2)
    assert.equal(providerMap['people.ai'], 1, 'dotted provider folded in from WorkflowStep.node')

    // co-occurrence: both audit runs share {gmail, slack}.
    assert.deepEqual(profile.coOccurrence, [{ providers: ['gmail', 'slack'], runs: 2 }])

    // runCount = 3 distinct runs (exec1, exec2, the workflow execution).
    assert.equal(profile.runCount, 3)
    assert.equal(profile.windowDays, 90)

    // topTools includes the distinct (provider,tool) pairs, none from orgB.
    const toolKeys = profile.topTools.map((t: any) => `${t.provider}.${t.tool}`)
    assert.ok(toolKeys.includes('slack.send_message'))
    assert.ok(toolKeys.includes('gmail.read_thread'))
  })

  test('buildUsageProfile counts executed tool actions incl. approved deliveries, not lifecycle/undecided approvals', async () => {
    const org = await prisma.organization.create({ data: { name: 'usage filter', slug: `usage-filter-${Date.now()}` } })
    try {
      const ev = (action: string, resourceType: string | null, tool: string | null, runId: string | null) =>
        prisma.auditEvent.create({ data: { organizationId: org.id, action, resourceType, tool, executionId: runId } })

      // A normal (non-gated) tool call — counts once.
      await ev('tool.call', 'notion', 'create_page', 'run1')
      // A lifecycle event: publishing a flow. resourceType='flow', tool=null.
      // Must NOT surface as a phantom 'flow' provider.
      await ev('flow.published', 'flow', null, null)
      // An APPROVAL-GATED delivery: the write plane short-circuits BEFORE any
      // tool.write, so the run emits only requested (queued) + approved
      // (decideApproval ran the delivery). approval.approved is the SOLE
      // executed-delivery signal — it must count the provider exactly ONCE, and
      // is NOT double-counted with a tool.write (a gated call never emits one).
      await ev('approval.requested', 'nango:salesforce', 'create_lead', 'run2')
      await ev('approval.approved', 'nango:salesforce', 'create_lead', 'run2')
      // A REJECTED delivery: requested + rejected, the write never ran → 0.
      await ev('approval.requested', 'nango:gmail', 'send_email', 'run3')
      await ev('approval.rejected', 'nango:gmail', 'send_email', 'run3')
      // A separate NON-gated write in its own run → counts once via tool.write.
      await ev('tool.write', 'slack', 'send_message', 'run4')

      const profile = await buildUsageProfile(org.id)
      const providerMap = Object.fromEntries(profile.providers.map((p: any) => [p.provider, p.calls]))

      assert.equal(providerMap.notion, 1, 'a normal tool.call counts once')
      assert.equal(
        providerMap['nango:salesforce'],
        1,
        'approved delivery counted exactly once (approval.approved), not double-counted with a tool.write and not tripled with approval.requested',
      )
      assert.equal(providerMap['nango:gmail'], undefined, 'a rejected delivery never executed → not counted')
      assert.equal(providerMap.slack, 1, 'a non-gated tool.write counts once')
      assert.equal(providerMap.flow, undefined, 'flow.published lifecycle event is not a provider')
      // runCount = 3 executed-tool runs (run1 tool.call, run2 approval.approved,
      // run4 tool.write). run3 (rejected) and the null-run lifecycle row are ignored.
      assert.equal(profile.runCount, 3)
    } finally {
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {})
    }
  })

  test('buildUsageProfile includes capabilities for a connected provider with ZERO calls', async () => {
    const org = await prisma.organization.create({ data: { name: 'usage caps', slug: `usage-caps-${Date.now()}` } })
    try {
      // A connected Nango Slack plane, but no audit/workflow activity at all.
      await prisma.nangoConnection.create({
        data: { organizationId: org.id, connectionId: `slack-${crypto.randomUUID()}`, providerConfigKey: 'slack', status: 'connected' },
      })
      const profile = await buildUsageProfile(org.id)
      assert.deepEqual(profile.providers, [], 'zero calls → no usage rows')
      const slackCaps = profile.capabilities.find((c: any) => c.provider === 'slack')
      assert.ok(slackCaps, 'a freshly-connected provider contributes its capability list even with zero calls')
      assert.ok(slackCaps.capabilities.length > 0, 'capability list is non-empty')
    } finally {
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {})
    }
  })

  test('buildUsageProfile surfaces People.ai themes (distinct signal types) only when connected', async () => {
    const org = await prisma.organization.create({ data: { name: 'usage themes', slug: `usage-themes-${Date.now()}` } })
    const user = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), email: `themes-${Date.now()}@example.com`, name: 'T', organizationId: org.id },
    })
    try {
      // Signals exist, but NO People.ai connection yet → themes gated off.
      await prisma.signal.create({ data: { organizationId: org.id, type: 'deal.risk_detected', payload: {}, dedupeKey: `d1-${crypto.randomUUID()}` } })
      const before = await buildUsageProfile(org.id)
      assert.deepEqual(before.themes, [], 'no themes without a People.ai connection')

      // Connect People.ai (default status 'active') + add a second distinct type.
      const conn = await prisma.peopleAiConnection.create({ data: { organizationId: org.id, userId: user.id, accessToken: 'enc-token' } })
      await prisma.signal.create({ data: { organizationId: org.id, type: 'forecast.updated', payload: {}, dedupeKey: `d2-${crypto.randomUUID()}` } })
      await prisma.signal.create({ data: { organizationId: org.id, type: 'deal.risk_detected', payload: {}, dedupeKey: `d3-${crypto.randomUUID()}` } })

      const after = await buildUsageProfile(org.id)
      assert.deepEqual(after.themes, ['deal.risk_detected', 'forecast.updated'], 'distinct signal types, deduped + sorted')

      // Revoke the connection → a disconnected People.ai must not leak themes,
      // matching the canonical "connected" (status==='active') predicate.
      await prisma.peopleAiConnection.updateMany({ where: { id: conn.id, organizationId: org.id }, data: { status: 'revoked' } })
      const revoked = await buildUsageProfile(org.id)
      assert.deepEqual(revoked.themes, [], 'no themes once the People.ai connection is revoked')
    } finally {
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {})
    }
  })

  test('buildUsageProfile marks the profile sampled exactly when the audit read hits the 500-row cap', async () => {
    const { MAX_AUDIT_ROWS } = await import('@/lib/templates/usage-profile')
    const org = await prisma.organization.create({ data: { name: 'usage cap', slug: `usage-cap-${Date.now()}` } })
    try {
      // One row short of the cap: the full window is read, nothing is hidden.
      const under = Array.from({ length: MAX_AUDIT_ROWS - 1 }, (_, i) =>
        prisma.auditEvent.create({
          data: { organizationId: org.id, action: 'tool.call', resourceType: 'slack', tool: 'send', executionId: `r${i}` },
        }))
      await Promise.all(under)
      const beforeCap = await buildUsageProfile(org.id)
      assert.equal(beforeCap.runCount, MAX_AUDIT_ROWS - 1)
      assert.equal(beforeCap.sampled, false, 'reading fewer than the cap means the window is complete')

      // One more row lands the read exactly ON the cap -- now truncated.
      await prisma.auditEvent.create({
        data: { organizationId: org.id, action: 'tool.call', resourceType: 'slack', tool: 'send', executionId: `r${MAX_AUDIT_ROWS}` },
      })
      const atCap = await buildUsageProfile(org.id)
      assert.equal(atCap.runCount, MAX_AUDIT_ROWS, 'the read itself is capped at MAX_AUDIT_ROWS')
      assert.equal(atCap.sampled, true, 'hitting the cap exactly means more rows may exist beyond what was read')
    } finally {
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {})
    }
  })

  test('buildUsageProfile is empty for an org with no activity', async () => {
    const org = await prisma.organization.create({ data: { name: 'usage empty', slug: `usage-empty-${Date.now()}` } })
    try {
      const profile = await buildUsageProfile(org.id)
      assert.deepEqual(profile.providers, [])
      assert.deepEqual(profile.coOccurrence, [])
      assert.equal(profile.runCount, 0)
      assert.equal(profile.windowDays, 90)
    } finally {
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {})
    }
  })
}
