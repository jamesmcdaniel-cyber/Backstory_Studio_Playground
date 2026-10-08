import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readoutHtml } from './readout-fixture'

/**
 * The three ways an account gets a report without a fresh build, against a
 * real database: Backstory's value readout loaded from its page; HP's
 * Account 360 page standing in until a full build; and a saved page re-drawn
 * with today's layout when it is opened.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: { organizationId: string; userId: string; cleanup: () => Promise<void> }
  let service: typeof import('../service')
  let pages: typeof import('../personal-page')

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    service = await import('../service')
    pages = await import('../personal-page')
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  const versionsOf = (artifactId: string) => prisma.artifactVersion.count({ where: { artifactId, organizationId: seeded.organizationId } })

  test('a value readout becomes Backstory\'s report and lands on the loader\'s page; loading it again adds a version', async () => {
    const { importReadout } = await import('../readout-service')
    const first = await importReadout({ organizationId: seeded.organizationId, userId: seeded.userId, html: readoutHtml() })
    assert.equal(first.account, 'Backstory')
    assert.equal(first.created, true)
    assert.equal(first.result.status, 'ready')
    const report = await service.findAccountReport(seeded.organizationId, 'backstory')
    assert.equal(report?.state?.source, 'readout')
    assert.equal(report?.state?.config?.fiscalYearStartMonth, 2, 'the fiscal year starts where the readout\'s first quarter does')
    const page = await pages.loadPersonalPage(seeded.organizationId, seeded.userId)
    assert.equal(page?.currentAccount, 'Backstory')
    assert.equal(page?.accounts.backstory?.basedOnVersionId, report?.currentVersionId)

    const second = await importReadout({ organizationId: seeded.organizationId, userId: seeded.userId, html: readoutHtml('A newer readout, loaded again.') })
    assert.equal(second.created, false)
    const again = await service.findAccountReport(seeded.organizationId, 'Backstory')
    assert.equal(again?.artifactId, report?.artifactId, 'one report per account')
    assert.equal(await versionsOf(report!.artifactId), 2)
    assert.equal(again?.state?.narrative.headline, 'A newer readout, loaded again.')
  })

  test('an account whose only analysis is an Account 360 page shows a report drawn from it', async () => {
    const { storeFacts } = await import('../artifact-state')
    const { createArtifact } = await import('@/lib/artifacts/service')
    const months = ['2026-03', '2026-04', '2026-05']
    const accounts = [
      { account: 'Globex', cohort: 'Power Users', unique_sessions: 9, deep_action_ratio: 0.3, unique_users: 3, created_by_month: [4_000_000, 0, 0], closed_won_by_month: [0, 1_000_000, 0] },
      { account: 'Umbrella', cohort: 'No Engagement', unique_sessions: 0, deep_action_ratio: 0, unique_users: 0, created_by_month: [100_000, 0, 0], closed_won_by_month: [0, 0, 0] },
    ]
    const cohorts = ['Power Users', 'Frequent Browsers', 'Focused Diggers', 'Light Touch', 'No Engagement'].map((cohort) => {
      const rows = accounts.filter((a) => a.cohort === cohort)
      const created = rows.reduce((s, a) => s + a.created_by_month.reduce((x, y) => x + y, 0), 0)
      return { cohort, n: rows.length, avg_created: rows.length ? created / rows.length : 0, avg_closed_won: 0, total_created: created, total_closed_won: 0 }
    })
    const a360 = { BUNDLE: { months, cohorts_static: cohorts, accounts, whale_names: [], dark_names: ['Umbrella'], top_users: [], session_median: 4, depth_ratio_median: 0.1 }, META: { accounts: 2, engaged: 1, noEngagement: 1, clickStart: '2026-03-01', clickEnd: '2026-05-31', excludedUsers: [], breadthCutoff: 5, eventsTotal: 10, eventsUsed: 10, usersActive: 2, wonBeyondWindow: 0, lastMonthPartial: false }, notes: [] }
    const factsFileId = await storeFacts(seeded.organizationId, seeded.userId, a360 as never)
    const { artifact } = await createArtifact({ organizationId: seeded.organizationId, userId: seeded.userId, kind: 'page', title: 'Account 360 ROI · HP', content: '<!DOCTYPE html><html><body><h1>HP</h1></body></html>', state: { roi: { template: 'account360', analysisId: 'a', account: 'HP', factsFileId, datasetIds: [], headline: 'A very long agent headline that goes on and on about the accounts and what they carry and why it matters for the renewal.' } } })
    await prisma.roiAnalysis.create({ data: { organizationId: seeded.organizationId, userId: seeded.userId, account: 'HP', template: 'account360', artifactId: artifact.id, status: 'completed', timeframe: {}, config: {}, reason: '', context: '', datasetIds: [] } })
    // A failed standard build, with nothing saved, does not hide it.
    const { artifact: empty } = await createArtifact({ organizationId: seeded.organizationId, userId: seeded.userId, kind: 'roi_dashboard', title: 'ROI analysis · HP', content: '<!DOCTYPE html><html><body>x</body></html>' })
    await prisma.artifactVersion.deleteMany({ where: { artifactId: empty.id, organizationId: seeded.organizationId } })
    await prisma.artifact.update({ where: { id: empty.id, organizationId: seeded.organizationId }, data: { currentVersionId: null } })
    await prisma.roiAnalysis.create({ data: { organizationId: seeded.organizationId, userId: seeded.userId, account: 'HP', template: 'standard', artifactId: empty.id, status: 'failed', error: 'contract', timeframe: {}, config: {}, reason: '', context: '', datasetIds: [] } })

    const report = await service.findAccountReport(seeded.organizationId, 'HP')
    assert.equal(report?.artifactId, artifact.id)
    assert.equal(report?.a360?.factsFileId, factsFileId)
    const opened = await service.openRoiAccount({ organizationId: seeded.organizationId, userId: seeded.userId, account: 'HP' })
    assert.equal(opened.status, 'ready')
    const page = await pages.loadPersonalPage(seeded.organizationId, seeded.userId)
    const version = await prisma.artifactVersion.findFirst({ where: { id: page!.accounts.hp!.versionId, organizationId: seeded.organizationId }, select: { state: true, content: true } })
    const state = (version.state as { roi: { a360FactsFileId: string; narrative: { headline: string; findings: Array<{ tab: string }> } } }).roi
    assert.equal(state.a360FactsFileId, factsFileId)
    assert.equal(state.narrative.headline, 'Accounts worked in depth carry 40× the pipeline.', 'a headline too long for a title is replaced')
    assert.ok(state.narrative.findings.every((f) => f.tab === 'accounts'))
    assert.match(version.content, /const A360 = \{/)
  })

  test('a page drawn with an older layout is re-drawn from its own state when opened', async () => {
    const { ROI_RENDER_VERSION } = await import('../dashboard')
    const page = await pages.loadPersonalPage(seeded.organizationId, seeded.userId)
    const mine = page!.accounts.backstory!
    const version = await prisma.artifactVersion.findFirst({ where: { id: mine.versionId, organizationId: seeded.organizationId }, select: { state: true } })
    await prisma.artifactVersion.update({ where: { id: mine.versionId, organizationId: seeded.organizationId }, data: { state: { roi: { ...(version.state as { roi: object }).roi, render: 1 } } } })
    assert.equal((await pages.loadPersonalPage(seeded.organizationId, seeded.userId))!.accounts.backstory!.stale, true)
    const before = await versionsOf(page!.artifactId)
    const opened = await service.openRoiAccount({ organizationId: seeded.organizationId, userId: seeded.userId, account: 'Backstory' })
    assert.ok(opened.status === 'ready' && opened.versionId !== mine.versionId)
    assert.equal(await versionsOf(page!.artifactId), before + 1)
    const fresh = (await pages.loadPersonalPage(seeded.organizationId, seeded.userId))!.accounts.backstory!
    assert.equal(fresh.stale, false)
    const redrawn = await prisma.artifactVersion.findFirst({ where: { id: fresh.versionId, organizationId: seeded.organizationId }, select: { state: true } })
    assert.equal((redrawn.state as { roi: { render: number } }).roi.render, ROI_RENDER_VERSION)
    // Opening it again changes nothing.
    await service.openRoiAccount({ organizationId: seeded.organizationId, userId: seeded.userId, account: 'Backstory' })
    assert.equal(await versionsOf(page!.artifactId), before + 1)
  })
}

if (process.env.TEST_DATABASE_URL) {
  test('an account with no report opens on what Backstory and Salesforce show live, and only on the reader\'s page', async () => {
    const { prisma } = await import('@/lib/prisma')
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    const pages = await import('../personal-page')
    const seededLive = await seedTestOrg(prisma)
    try {
      const fetchLive = async () => ({
        fetchedAt: new Date().toISOString(),
        scope: 'account' as const,
        sources: [{ name: 'Backstory' as const, ok: true }, { name: 'Salesforce' as const, ok: true }],
        opportunities: [{ name: 'Initech - Renewal', type: 'Renewal', amount: 50000, closeDate: '2026-12-01', engagement: 80, owner: 'Dana' }],
        salesforce: { closedWon: 3, closedLost: 1, wonAmount: 90000, avgDaysToClose: 40, byType: [], byFy: [], openByStage: [] },
      })
      const opened = await pages.openAccountOnPage({ organizationId: seededLive.organizationId, userId: seededLive.userId, account: 'Initech', findGeneric: async () => null, fetchLive })
      assert.equal(opened.status, 'ready')
      const page = await pages.loadPersonalPage(seededLive.organizationId, seededLive.userId)
      const version = await prisma.artifactVersion.findFirst({ where: { id: page!.accounts.initech!.versionId, organizationId: seededLive.organizationId }, select: { content: true, state: true } })
      assert.match(version!.content, /Initech today · live from Backstory and Salesforce/)
      assert.equal((version!.state as { roi: { live: { salesforce: { closedWon: number } } } }).roi.live.salesforce.closedWon, 3)
      // Nothing to read: still "build it".
      const empty = await pages.openAccountOnPage({ organizationId: seededLive.organizationId, userId: seededLive.userId, account: 'Globex', findGeneric: async () => null, fetchLive: async () => ({ fetchedAt: new Date().toISOString(), sources: [] }) })
      assert.equal(empty.status, 'needs_build')
    } finally {
      await seededLive.cleanup()
    }
  })
}

if (process.env.TEST_DATABASE_URL) {
  test('accounts kept off the page are not listed — Iron Mountain until the owner says otherwise', async () => {
    const { prisma } = await import('@/lib/prisma')
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    const { importReadout } = await import('../readout-service')
    const { loadRoiPageSetup } = await import('../page-setup')
    const { findRoiAgent, setRoiHiddenAccounts } = await import('../agent')
    const s = await seedTestOrg(prisma)
    try {
      await importReadout({ organizationId: s.organizationId, userId: s.userId, html: readoutHtml(), account: 'Iron Mountain' })
      await importReadout({ organizationId: s.organizationId, userId: s.userId, html: readoutHtml(), account: 'HP' })
      const setupOf = () => loadRoiPageSetup({ organizationId: s.organizationId, userId: s.userId, role: 'ADMIN', canWriteAgents: true })
      const first = await setupOf()
      assert.deepEqual(first.accounts.map((a) => a.account), ['Backstory', 'HP'])
      assert.deepEqual(first.hiddenAccounts, ['Iron Mountain'])
      assert.deepEqual(first.hiddenAvailable, ['Iron Mountain'])
      await setRoiHiddenAccounts(s.organizationId, (await findRoiAgent(s.organizationId))!, [])
      assert.deepEqual((await setupOf()).accounts.map((a) => a.account), ['Backstory', 'HP', 'Iron Mountain'])
    } finally {
      await s.cleanup()
    }
  })
}
