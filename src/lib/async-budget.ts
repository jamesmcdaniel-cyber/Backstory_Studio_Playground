/** Optional context must not hold the first token hostage. No secret/result
 * cache is introduced; the original promise remains rejection-handled. */
export async function withinBudget<T>(task: Promise<T>, milliseconds: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([task.catch(() => fallback), new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), milliseconds) })])
  } finally { if (timer) clearTimeout(timer) }
}
