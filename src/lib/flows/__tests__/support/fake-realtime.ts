type Handler = (payload: { payload?: Record<string, unknown>; key?: string }) => void

/**
 * An in-memory stand-in for Supabase Realtime: channels sharing a topic share a
 * room, broadcasts reach every OTHER member, and presence is a map of tracked
 * payloads. Synchronous, so tests need no timers.
 *
 * `denyWrite` models the RLS wall on the ops topic — a channel whose topic is
 * denied silently drops sends, exactly as Postgres refusing the INSERT does.
 */
export class FakeRealtime {
  rooms = new Map<string, Set<FakeChannel>>()
  denyWrite = new Set<string>()
  realtime = { setAuth: async () => {} }

  channel(topic: string): FakeChannel {
    return new FakeChannel(this, topic)
  }

  removeChannel(channel: FakeChannel) {
    this.rooms.get(channel.topic)?.delete(channel)
  }

  members(topic: string): FakeChannel[] {
    return Array.from(this.rooms.get(topic) ?? [])
  }
}

export class FakeChannel {
  handlers: { type: string; event: string; handler: Handler }[] = []
  presence: Record<string, Record<string, unknown>[]> = {}

  constructor(readonly hub: FakeRealtime, readonly topic: string) {}

  on(type: string, filter: { event: string }, handler: Handler): FakeChannel {
    this.handlers.push({ type, event: filter.event, handler })
    return this
  }

  subscribe(callback?: (status: string) => void): FakeChannel {
    const room = this.hub.rooms.get(this.topic) ?? new Set<FakeChannel>()
    room.add(this)
    this.hub.rooms.set(this.topic, room)
    callback?.('SUBSCRIBED')
    return this
  }

  send(message: { type: string; event: string; payload: Record<string, unknown> }) {
    if (this.hub.denyWrite.has(this.topic)) return Promise.resolve('error')
    for (const peer of this.hub.members(this.topic)) {
      if (peer === this) continue
      for (const binding of peer.handlers) {
        if (binding.type === message.type && binding.event === message.event) {
          binding.handler({ payload: message.payload })
        }
      }
    }
    return Promise.resolve('ok')
  }

  track(payload: Record<string, unknown>) {
    if (this.hub.denyWrite.has(this.topic)) return Promise.resolve('error')
    const key = String(payload.clientId)
    for (const peer of this.hub.members(this.topic)) {
      const isNew = !(key in peer.presence)
      peer.presence[key] = [payload]
      for (const binding of peer.handlers) {
        if (binding.type !== 'presence') continue
        if (binding.event === 'sync') binding.handler({})
        if (binding.event === 'join' && isNew) binding.handler({ key })
      }
    }
    return Promise.resolve('ok')
  }

  untrack() {
    return Promise.resolve('ok')
  }

  presenceState<T>(): Record<string, T[]> {
    return this.presence as unknown as Record<string, T[]>
  }
}
