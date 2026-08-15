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
  /** Every channel instance ever created, so tests can assert that recovery
   *  happens on a FRESH instance rather than by re-subscribing a dead one. */
  created: FakeChannel[] = []
  realtime = { setAuth: async () => {} }

  channel(topic: string): FakeChannel {
    const channel = new FakeChannel(this, topic)
    this.created.push(channel)
    return channel
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
  /** Mirrors realtime-js: subscribe() is one-shot per instance. */
  joinedOnce = false
  private callback?: (status: string, error?: Error) => void

  constructor(readonly hub: FakeRealtime, readonly topic: string) {}

  on(type: string, filter: { event: string }, handler: Handler): FakeChannel {
    this.handlers.push({ type, event: filter.event, handler })
    return this
  }

  subscribe(callback?: (status: string, error?: Error) => void): FakeChannel {
    // Real realtime-js throws this exact way (a string, not an Error) when a
    // channel instance is subscribed twice; the fake enforces it so hooks that
    // "retry" by re-subscribing a dead instance fail here like they do in prod.
    if (this.joinedOnce) {
      throw `tried to subscribe multiple times. 'subscribe' can only be called a single time per channel instance`
    }
    this.joinedOnce = true
    this.callback = callback
    const room = this.hub.rooms.get(this.topic) ?? new Set<FakeChannel>()
    room.add(this)
    this.hub.rooms.set(this.topic, room)
    callback?.('SUBSCRIBED')
    return this
  }

  /** The server closing the channel (Realtime restart, idle kick). Like the
   *  real client, a closed channel leaves the room and will NOT rejoin itself. */
  serverClose() {
    this.hub.rooms.get(this.topic)?.delete(this)
    this.callback?.('CLOSED')
  }

  /** A channel-level failure (join refused, transport error). */
  serverError() {
    this.hub.rooms.get(this.topic)?.delete(this)
    this.callback?.('CHANNEL_ERROR', new Error('fake channel error'))
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
