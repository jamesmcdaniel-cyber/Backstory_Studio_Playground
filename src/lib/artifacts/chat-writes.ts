import type { Artifact, Prisma } from '@prisma/client'
import type { ArtifactChatMessage } from './types'

/**
 * The artifact's conversation is one JSON column rewritten whole, and several
 * writers rewrite it: a send, the poll that reconciles pending answers, the
 * run that attaches its version. Each is a read-modify-write, so without a
 * guard a poll that read the row a moment before a send lands would put the
 * old conversation back — the sent message gone, its run orphaned.
 *
 * Every write here is a compare-and-swap on the row's `updatedAt`: it lands
 * only if the row is still the one that was read. On a miss the row is read
 * again and the mutation recomputed from the fresh conversation, a few times;
 * a mutation that no longer applies returns null and nothing is written.
 */

export const CHAT_WRITE_ATTEMPTS = 3

export class ChatConflictError extends Error {
  constructor() {
    super('The conversation changed while saving. Try again.')
    this.name = 'ChatConflictError'
  }
}

/** The slice of a Prisma client the writes need — the full client, a transaction, or a test double. */
export type ChatWriteClient = {
  artifact: {
    findFirst(args: { where: { id: string; organizationId: string } }): Promise<Artifact | null>
    updateMany(args: { where: { id: string; organizationId: string; updatedAt: Date }; data: { chat: Prisma.InputJsonValue } }): Promise<{ count: number }>
  }
}

export type ChatMutation = (chat: ArtifactChatMessage[], row: Artifact) => Promise<ArtifactChatMessage[] | null> | ArtifactChatMessage[] | null

export function chatOf(row: Pick<Artifact, 'chat'>): ArtifactChatMessage[] {
  return Array.isArray(row.chat) ? (row.chat as ArtifactChatMessage[]) : []
}

export function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue
}

/** One guarded write: lands only if the row is still as `row` was read. */
export async function casChatWrite(client: ChatWriteClient, row: Pick<Artifact, 'id' | 'organizationId' | 'updatedAt'>, chat: ArtifactChatMessage[]): Promise<boolean> {
  const written = await client.artifact.updateMany({ where: { id: row.id, organizationId: row.organizationId, updatedAt: row.updatedAt }, data: { chat: jsonValue(chat) } })
  return written.count > 0
}

/**
 * Read, mutate, write — retried from a fresh read when the row moved in
 * between. Returns the row as it stands afterwards (re-read, so `updatedAt`
 * is current), or null when the artifact is gone. `mutate` returning null
 * means there is nothing to write for this conversation; the row is returned
 * as read. After CHAT_WRITE_ATTEMPTS misses, ChatConflictError.
 */
export async function rewriteChat(client: ChatWriteClient, organizationId: string, artifactId: string, mutate: ChatMutation, snapshot?: Artifact | null): Promise<Artifact | null> {
  const where = { id: artifactId, organizationId }
  let row = snapshot === undefined ? await client.artifact.findFirst({ where }) : snapshot
  for (let attempt = 0; attempt < CHAT_WRITE_ATTEMPTS; attempt++) {
    if (!row) return null
    const next = await mutate(chatOf(row), row)
    if (!next) return row
    const written = await casChatWrite(client, row, next)
    row = await client.artifact.findFirst({ where })
    if (written) return row
  }
  throw new ChatConflictError()
}
