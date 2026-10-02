import '@/test-support/jsdom-env'
import test from 'node:test'
import assert from 'node:assert/strict'
import { getSnapshot, peekSnapshot, resetSnapshotCache, seedSnapshotAgent } from '../snapshot'
import type { Agent } from '@/lib/types'

test('confirmed agent seed survives an older in-flight snapshot and rejects another workspace', async () => {
  const original = globalThis.fetch
  const agent = { id: 'new', title: 'New agent', instructions: 'Do work', integrations: [], skills: [] } as unknown as Agent
  try {
    resetSnapshotCache()
    globalThis.fetch = async () => Response.json({ agents: [], activeOrganizationId: 'org-a' })
    await getSnapshot(0)
    let finish!: (r: Response) => void
    globalThis.fetch = () => new Promise(resolve => { finish = resolve })
    const stale = getSnapshot(0)
    assert.equal(seedSnapshotAgent(agent, 'org-b'), false)
    assert.equal(seedSnapshotAgent(agent, 'org-a'), true)
    finish(Response.json({ agents: [], activeOrganizationId: 'org-a' }))
    assert.deepEqual((await stale).agents.map(a => a.id), ['new'])
    assert.deepEqual(peekSnapshot()?.agents.map(a => a.id), ['new'])
    resetSnapshotCache()
    assert.equal(seedSnapshotAgent(agent, 'org-a'), false)
  } finally { globalThis.fetch = original; resetSnapshotCache() }
})
