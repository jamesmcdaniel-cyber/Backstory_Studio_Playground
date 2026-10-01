/** Bounded FIFO admission. Queued requests hold no browser or uploaded body. */
export function admission({ capacity = 1, limit = 3, timeoutMs = 60000 } = {}) {
  let active = 0
  const waiting = []
  function release() { active--; waiting.shift()?.grant() }
  return {
    stats: () => ({ active, queued: waiting.length, capacity, limit }),
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(new Error('Validation request cancelled'))
      if (active < capacity) { active++; return Promise.resolve(release) }
      if (waiting.length >= limit) return Promise.reject(new Error('Validation queue full; retry shortly'))
      return new Promise((resolve, reject) => {
        const remove = () => { const index = waiting.indexOf(item); if (index >= 0) waiting.splice(index, 1); clearTimeout(timer); signal?.removeEventListener('abort', abort) }
        const abort = () => { remove(); reject(new Error('Validation request cancelled')) }
        const item = { grant() { remove(); active++; resolve(release) } }
        const timer = setTimeout(() => { remove(); reject(new Error('Validation queue deadline exceeded; retry shortly')) }, timeoutMs)
        signal?.addEventListener('abort', abort, { once: true })
        waiting.push(item)
      })
    },
  }
}
