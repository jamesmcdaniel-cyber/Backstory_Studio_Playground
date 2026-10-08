import test from 'node:test'
import assert from 'node:assert/strict'
import { canViewRoiAnalysis, isOrphanedRun } from '../service'
import { refreshLive } from '../personal-page'
import type { RoiLiveAccount } from '../live-account'

const minute = 60_000

test('a pending row that never got a run is orphaned after 15 minutes, a started or flowing one never is', () => {
  const now = Date.now()
  const base = { status: 'pending', executionId: null, results: null, createdAt: new Date(now - 20 * minute) }
  assert.equal(isOrphanedRun(base, now), true)
  assert.equal(isOrphanedRun({ ...base, createdAt: new Date(now - 5 * minute) }, now), false, 'still within the start window')
  assert.equal(isOrphanedRun({ ...base, executionId: 'exec' }, now), false, 'a run exists; the run decides')
  assert.equal(isOrphanedRun({ ...base, results: { dataFlowRunId: 'flow' } }, now), false, 'a data flow is fetching')
  assert.equal(isOrphanedRun({ ...base, status: 'running' }, now), false)
})

test('history visibility: builds show to everyone, a page run only to its owner', () => {
  const pages = new Set(['page-a'])
  assert.equal(canViewRoiAnalysis({ userId: 'a', artifactId: 'page-a', results: { personal: true } }, 'a', pages), true)
  assert.equal(canViewRoiAnalysis({ userId: 'a', artifactId: 'page-a', results: { personal: true } }, 'b', pages), false)
  assert.equal(canViewRoiAnalysis({ userId: 'a', artifactId: 'page-a', results: null }, 'b', pages), false, 'landing on a page is enough')
  assert.equal(canViewRoiAnalysis({ userId: 'a', artifactId: 'report', results: { populatePage: true } }, 'b', pages), true)
})

const live = (over: Partial<RoiLiveAccount>): RoiLiveAccount => ({ fetchedAt: '2026-10-01T00:00:00.000Z', sources: [{ name: 'Backstory', ok: true }, { name: 'Salesforce', ok: true }], scope: 'account', ...over } as RoiLiveAccount)

test('a live re-read that comes back empty keeps the data the page had', async () => {
  const good = live({ opportunities: [{ name: 'Renewal' }] as never })
  const empty = live({ fetchedAt: '2026-10-08T00:00:00.000Z', sources: [{ name: 'Backstory', ok: false, note: 'timeout' }, { name: 'Salesforce', ok: false, note: 'timeout' }] })
  assert.equal(await refreshLive(good, async () => empty), good, 'kept, with its old fetchedAt so the next open tries again')
  const fresh = live({ fetchedAt: '2026-10-08T00:00:00.000Z', opportunities: [{ name: 'Expansion' }] as never })
  assert.equal(await refreshLive(good, async () => fresh), fresh)
  assert.equal(await refreshLive(undefined, async () => empty), empty, 'nothing to keep: the empty read stands')
})
