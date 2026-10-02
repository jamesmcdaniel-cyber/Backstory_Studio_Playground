/** Share concurrent reads only; settled values are never retained here. */
export function singleFlight<T>() {
  const pending = new Map<string, Promise<T>>()
  return (key: string, load: () => Promise<T>): Promise<T> => {
    const existing = pending.get(key)
    if (existing) return existing
    const request = Promise.resolve().then(load).finally(() => {
      if (pending.get(key) === request) pending.delete(key)
    })
    pending.set(key, request)
    return request
  }
}
