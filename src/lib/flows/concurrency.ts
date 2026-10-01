import { randomUUID } from 'node:crypto'
import { getRedisConnection } from '@/lib/queue/config'
import { inlineExecution } from '@/lib/queue/execution-mode'

/** Only full-graph replacements need optimistic concurrency protection. */
export function shouldGuardFlowWrite(input: { graph: unknown; baseUpdatedAt?: string }): boolean {
  return input.graph !== undefined && Boolean(input.baseUpdatedAt)
}

// Longer than the hard 30-minute execution cap. A process crash cannot strand
// a slot forever; release is token-specific, never a delete of someone else's.
export const FLOW_SLOT_TTL_MS = 45 * 60_000
export const ACQUIRE_FLOW_SLOT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[3]), ARGV[2])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1`

const localSlots = new Map<string, Set<string>>()
export async function acquireFlowSlot(organizationId: string, flowId: string, limit: number): Promise<(() => Promise<void>) | null> {
  const key = `flow-slots:${organizationId}:${flowId}`
  const token = randomUUID()
  if (inlineExecution) {
    const slots = localSlots.get(key) ?? new Set<string>()
    if (slots.size >= limit) return null
    slots.add(token)
    localSlots.set(key, slots)
    return async () => { slots.delete(token); if (!slots.size) localSlots.delete(key) }
  }
  const redis = getRedisConnection()
  const acquired = await redis.eval(ACQUIRE_FLOW_SLOT, 1, key, limit, token, FLOW_SLOT_TTL_MS)
  if (Number(acquired) !== 1) return null
  return async () => { await redis.zrem(key, token) }
}
