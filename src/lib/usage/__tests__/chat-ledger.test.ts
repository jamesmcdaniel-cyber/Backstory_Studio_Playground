import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildChatLedgerContext } from '../chat-ledger'

describe('buildChatLedgerContext', () => {
  it('stamps the run.chat surface and threads the chatting user through', () => {
    const ctx = buildChatLedgerContext({ organizationId: 'org-1', userId: 'user-1' })
    assert.deepEqual(ctx, { organizationId: 'org-1', userId: 'user-1', surface: 'run.chat' })
  })

  it('defaults userId to null rather than undefined — an explicit "nobody" for pre-attribution rows', () => {
    const ctx = buildChatLedgerContext({ organizationId: 'org-1' })
    assert.equal(ctx.userId, null)
  })
})
