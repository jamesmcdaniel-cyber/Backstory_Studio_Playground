import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Everyone's own ROI page against a real database. Opening an account puts
 * its report on the person's page — one artifact per person, never another —
 * opening it again changes nothing, another account is the page's next
 * version, and nothing that lists accounts' reports mistakes a person's page
 * for one. Run history shows a person's own page runs to them alone.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: { organizationId: string; userId: string; cleanup: () => Promise<void> }
  let colleague: string
  let service: typeof import('../service')
  let pages: typeof import('../personal-page')

  const NARRATIVE = {
    headline: 'Engaged deals win more often, and Backstory users create that engagement.',
    lede: 'High-engagement deals win far more often than low-engagement ones.',
    findings: [
      { fig: '2.0×', cap: 'win rate, high vs low', h: 'Engagement predicts wins', p: 'High-engagement deals win **60%**.', tab: 'deals' as const },
      { fig: '+12%', cap: 'meetings per rep', h: 'Reps meet more buyers', p: 'Meetings rose **12%**.', tab: 'activity' as const },
    ],
    watch: [{ lead: 'Renewals', text: 'Watch the renewal book.' }, { lead: 'Coverage', text: 'Keep VP coverage up.' }],
    notes: {},
    caveats: [],
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    colleague = (await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: seeded.organizationId, isActive: true, role: 'USER', name: 'Colleague' } })).id
    service = await import('../service')
    pages = await import('../personal-page')
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  /** An account's report as a build leaves it: an artifact, a version with its state, the build's row. */
  async function accountReport(account: string, reason = 'QBR') {
    const { storeFacts, stateJson } = await import('../artifact-state')
    const { createArtifact } = await import('@/lib/artifacts/service')
    const { renderRoiDashboard } = await import('../dashboard')
    const { DEFAULT_RUN_CONFIG } = await import('../config')
    const { EMPTY_VIEW } = await import('../view')
    const facts = { U: null, OPP: null, ST: null, META: {}, notes: [] }
    const factsFileId = await storeFacts(seeded.organizationId, seeded.userId, facts)
    const html = renderRoiDashboard(facts, NARRATIVE, { account, config: DEFAULT_RUN_CONFIG, reason })
    const state = stateJson({ analysisId: `analysis-${account}`, account, timeframePreset: 'last6_vs_prior6', factsFileId, datasetIds: [], narrative: NARRATIVE, view: EMPTY_VIEW, config: DEFAULT_RUN_CONFIG, reason })
    const { artifact, version } = await createArtifact({ organizationId: seeded.organizationId, userId: seeded.userId, kind: 'roi_dashboard', title: `ROI analysis · ${account}`, content: html, state })
    await prisma.roiAnalysis.create({ data: { organizationId: seeded.organizationId, userId: seeded.userId, account, template: 'standard', artifactId: artifact.id, status: 'completed', timeframe: { preset: 'last6_vs_prior6' }, config: DEFAULT_RUN_CONFIG, reason, context: '', datasetIds: [] } })
    return { artifactId: artifact.id, versionId: version.id, state, html }
  }

  const versionsOf = (artifactId: string) => prisma.artifactVersion.count({ where: { artifactId, organizationId: seeded.organizationId } })

  test('opening an account puts its report on the person\'s own page, once', async () => {
    const acme = await accountReport('Acme')
    const opened = await service.openRoiAccount({ organizationId: seeded.organizationId, userId: seeded.userId, account: 'acme' })
    assert.equal(opened.status, 'ready')
    assert.ok(opened.status === 'ready' && opened.artifactId !== acme.artifactId, 'the page is the person\'s own artifact, not the account\'s report')
    const again = await service.openRoiAccount({ organizationId: seeded.organizationId, userId: seeded.userId, account: 'Acme' })
    assert.deepEqual(again, opened)
    if (opened.status !== 'ready') return
    assert.equal(await versionsOf(opened.artifactId), 1)
    assert.equal(await versionsOf(acme.artifactId), 1, 'the account\'s report is untouched')

    const page = await pages.loadPersonalPage(seeded.organizationId, seeded.userId)
    assert.equal(page?.artifactId, opened.artifactId)
    assert.equal(page?.currentAccount, 'Acme')
    assert.equal(page?.accounts.acme?.basedOnVersionId, acme.versionId)
    // Listings of accounts' reports never include a person's page.
    const reports = await service.listAccountReports(seeded.organizationId)
    assert.deepEqual(reports.map((report) => report.artifactId), [acme.artifactId])
  })

  test('another account is the page\'s next version; going back moves the pointer, not the history', async () => {
    await accountReport('Globex')
    const acme = await service.openRoiAccount({ organizationId: seeded.organizationId, userId: seeded.userId, account: 'Acme' })
    const globex = await service.openRoiAccount({ organizationId: seeded.organizationId, userId: seeded.userId, account: 'Globex' })
    assert.ok(acme.status === 'ready' && globex.status === 'ready')
    assert.equal(globex.artifactId, acme.artifactId)
    assert.notEqual(globex.versionId, acme.versionId)
    assert.equal(await versionsOf(globex.artifactId), 2)
    const back = await service.openRoiAccount({ organizationId: seeded.organizationId, userId: seeded.userId, account: 'Acme' })
    assert.ok(back.status === 'ready')
    assert.equal(back.versionId, acme.versionId)
    assert.equal(await versionsOf(back.artifactId), 2)
    const page = await pages.loadPersonalPage(seeded.organizationId, seeded.userId)
    assert.equal(page?.currentAccount, 'Acme')
    assert.equal(page?.currentVersionId, acme.versionId)
  })

  test('newer data on the account\'s report reaches the page only when it is taken', async () => {
    const { addVersion } = await import('@/lib/artifacts/service')
    const { stateJson } = await import('../artifact-state')
    const report = await service.findAccountReport(seeded.organizationId, 'Acme')
    assert.ok(report?.state)
    const fresher = await addVersion({ artifactId: report.artifactId, organizationId: seeded.organizationId, content: '<!DOCTYPE html><html><body><h1>Acme, refreshed</h1></body></html>', state: stateJson({ ...report.state, reason: 'Renewal' }) })
    const { pageAccountOf } = await import('../page-setup')
    const page = await pages.loadPersonalPage(seeded.organizationId, seeded.userId)
    const latest = await service.findAccountReport(seeded.organizationId, 'Acme')
    const before = pageAccountOf({ account: 'Acme', extracts: [], covers: [], loadedAt: null, canRefresh: false, report: latest, page, myActiveRun: null })
    assert.equal(before.newerData, true)
    assert.equal(before.mine?.reason, 'QBR')

    const taken = await service.openRoiAccount({ organizationId: seeded.organizationId, userId: seeded.userId, account: 'Acme', update: true })
    assert.ok(taken.status === 'ready')
    const after = await pages.loadPersonalPage(seeded.organizationId, seeded.userId)
    assert.equal(after?.accounts.acme?.basedOnVersionId, fresher.id)
    assert.equal(after?.accounts.acme?.reason, 'Renewal', 'the page takes the report\'s findings and the settings they were written for')
    assert.equal(pageAccountOf({ account: 'Acme', extracts: [], covers: [], loadedAt: null, canRefresh: false, report: latest, page: after, myActiveRun: null }).newerData, false)
  })

  test('an account with no report has nothing to open until it is built', async () => {
    const result = await service.openRoiAccount({ organizationId: seeded.organizationId, userId: seeded.userId, account: 'Initech' })
    assert.equal(result.status, 'needs_build')
  })

  test('each person has their own page, and sees only their own page runs in history', async () => {
    const mine = await service.openRoiAccount({ organizationId: seeded.organizationId, userId: seeded.userId, account: 'Globex' })
    const theirs = await service.openRoiAccount({ organizationId: seeded.organizationId, userId: colleague, account: 'Globex' })
    assert.ok(mine.status === 'ready' && theirs.status === 'ready')
    assert.notEqual(theirs.artifactId, mine.artifactId)
    assert.equal((await pages.personalPageIds(seeded.organizationId)).size, 2)

    const { DEFAULT_RUN_CONFIG } = await import('../config')
    const theirChange = await prisma.roiAnalysis.create({ data: { organizationId: seeded.organizationId, userId: colleague, account: 'Globex', template: 'standard', artifactId: theirs.artifactId, status: 'completed', timeframe: { preset: 'last6_vs_prior6' }, config: DEFAULT_RUN_CONFIG, reason: 'Their QBR', context: '', datasetIds: [], results: { personal: true, versionId: theirs.versionId } } })
    const forMe = await service.listRoiAnalyses(seeded.organizationId, seeded.userId)
    const forThem = await service.listRoiAnalyses(seeded.organizationId, colleague)
    assert.ok(!forMe.some((run) => run.id === theirChange.id), 'someone else\'s page runs are theirs')
    const shown = forThem.find((run) => run.id === theirChange.id)
    assert.equal(shown?.pageVersionId, theirs.versionId)
    // Builds of an account's report are everyone's history.
    assert.ok(forThem.some((run) => run.account === 'Acme'))
  })
}
