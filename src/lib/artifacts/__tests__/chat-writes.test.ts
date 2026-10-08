import test from 'node:test'
import assert from 'node:assert/strict'
import type { Artifact } from '@prisma/client'
import { CHAT_WRITE_ATTEMPTS, ChatConflictError, casChatWrite, rewriteChat, type ChatWriteClient } from '../chat-writes'
import type { ArtifactChatMessage } from '../types'

/**
 * A fake artifact table: one row whose updatedAt moves on every write, as
 * Prisma's @updatedAt does, and a hook to slip a concurrent write in between
 * a read and the compare-and-swap that follows it.
 */
function table(chat: ArtifactChatMessage[] = []) {
  let row = { id: 'a1', organizationId: 'org', chat, updatedAt: new Date(1_000) } as unknown as Artifact
  let writes = 0
  let interleave: (() => void) | null = null
  const client: ChatWriteClient = {
    artifact: {
      async findFirst({ where }) { return where.id === row.id && where.organizationId === row.organizationId ? { ...row } : null },
      async updateMany({ where, data }) {
        interleave?.()
        if (where.id !== row.id || where.organizationId !== row.organizationId || where.updatedAt.getTime() !== row.updatedAt.getTime()) return { count: 0 }
        writes++
        row = { ...row, chat: data.chat as never, updatedAt: new Date(row.updatedAt.getTime() + 1) }
        return { count: 1 }
      },
    },
  }
  return {
    client,
    get row() { return row },
    get writes() { return writes },
    /** Another writer lands just before the next CAS: the row moves on. */
    concurrently(write: (chat: ArtifactChatMessage[]) => ArtifactChatMessage[], times = 1) {
      let left = times
      interleave = () => {
        if (left-- <= 0) return
        row = { ...row, chat: write(row.chat as ArtifactChatMessage[]) as never, updatedAt: new Date(row.updatedAt.getTime() + 1) }
      }
    },
  }
}

const user = (content: string): ArtifactChatMessage => ({ role: 'user', content, createdAt: 'now' })
const pending = (executionId: string): ArtifactChatMessage => ({ role: 'agent', content: '', executionId, status: 'pending', createdAt: 'now' })

test('a write lands only on the row it was computed from', async () => {
  const t = table([user('hi')])
  const stale = { ...t.row }
  assert.equal(await casChatWrite(t.client, t.row, [user('hi'), pending('e1')]), true)
  assert.equal(await casChatWrite(t.client, stale, [user('overwritten')]), false, 'the snapshot has moved on')
  assert.deepEqual(t.row.chat, [user('hi'), pending('e1')])
})

test('a poll’s reconcile recomputes from the fresh conversation instead of putting the old one back', async () => {
  // The poll read [pending e1]; a send lands [.., user, pending e2] before it writes.
  const t = table([pending('e1')])
  t.concurrently((chat) => [...chat, user('second question'), pending('e2')])
  const settled = await rewriteChat(t.client, 'org', 'a1', (chat) => {
    const message = chat.find((m) => m.executionId === 'e1')
    if (!message || message.status !== 'pending') return null
    return chat.map((m) => (m.executionId === 'e1' ? { ...m, status: 'completed' as const, content: 'done' } : m))
  })
  assert.equal(t.writes, 1)
  assert.deepEqual(settled?.chat, [{ ...pending('e1'), status: 'completed', content: 'done' }, user('second question'), pending('e2')], 'the send survives and e1 is still settled')
  assert.equal(settled?.updatedAt.getTime(), t.row.updatedAt.getTime(), 'the returned row carries the current updatedAt')
})

test('a second send sees the first one’s pending message on retry and refuses', async () => {
  const t = table([])
  t.concurrently((chat) => [...chat, user('first'), pending('e1')])
  await assert.rejects(
    rewriteChat(t.client, 'org', 'a1', (chat) => {
      if (chat.some((m) => m.status === 'pending')) throw new Error('Wait for the current answer before sending another.')
      return [...chat, user('second'), pending('e2')]
    }),
    /Wait for the current answer/,
  )
  assert.equal(t.writes, 0)
  assert.deepEqual(t.row.chat, [user('first'), pending('e1')], 'only the first send started a run')
})

test('a mutation with nothing to do writes nothing; a row that keeps moving gives up after the attempt limit', async () => {
  const t = table([user('hi')])
  const row = await rewriteChat(t.client, 'org', 'a1', () => null)
  assert.equal(t.writes, 0)
  assert.deepEqual(row?.chat, [user('hi')])
  t.concurrently((chat) => [...chat, user('busy')], CHAT_WRITE_ATTEMPTS)
  await assert.rejects(rewriteChat(t.client, 'org', 'a1', (chat) => [...chat, user('mine')]), (error: unknown) => error instanceof ChatConflictError)
  assert.equal(t.writes, 0)
  assert.equal(await rewriteChat(t.client, 'org', 'missing', (chat) => chat), null)
})
