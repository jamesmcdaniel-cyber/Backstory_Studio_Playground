/**
 * Execution mode: `queue` runs agents on the BullMQ worker; `inline` runs them
 * inside the request. Production defaults to `queue` so signal bursts and long
 * multi-turn runs never execute on (or time out) the serverless request path —
 * set EXECUTION_MODE explicitly to override. Development defaults to `inline`
 * so a single `next dev` needs no worker/Redis.
 */
export function resolveExecutionMode(): 'inline' | 'queue' {
  const explicit = process.env.EXECUTION_MODE
  if (explicit === 'queue' || explicit === 'inline') return explicit
  const inferred = process.env.NODE_ENV === 'production' ? 'queue' : 'inline'
  // Production must never run on an INFERRED mode silently: an empty value
  // (the Vercel env-CLI trap) or a typo resolves to `queue` — and if no
  // consumer exists, every run strands. Say which mode was inferred and why.
  if (process.env.NODE_ENV === 'production') {
    console.warn(
      `EXECUTION_MODE is ${explicit === undefined ? 'unset' : `invalid (${JSON.stringify(explicit)})`} — inferred "${inferred}". ` +
        'Set it to the literal "queue" or "inline" explicitly (inline on Vercel is unsupported: detached promises die when the function freezes).',
    )
  }
  return inferred
}

export const EXECUTION_MODE = resolveExecutionMode()
export const inlineExecution = EXECUTION_MODE !== 'queue'
