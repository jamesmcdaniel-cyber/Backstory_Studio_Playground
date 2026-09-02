/**
 * What a run's failed tool calls mean for its outcome.
 *
 * Run status used to derive only from integrations that never LOADED
 * (`blockingUnavailable`). A tool that loaded, was called, and failed had no
 * effect at all — so a run whose Gmail send failed three times, and one whose
 * evidence search timed out twice, both terminated as 'completed'. That is the
 * same dishonesty `blockingUnavailable` exists to prevent, one step later in
 * the run: the difference between "we could not deliver" and "we tried to
 * deliver and it did not work" matters to nobody reading the notification.
 *
 * The asymmetry between writes and reads is deliberate. A failed WRITE means
 * the asked-for thing did not happen — the run is blocked. A failed READ means
 * the artifact was still produced, but on thinner evidence than intended, so
 * the run completes and says so rather than claiming a clean success.
 */

export type ToolFailure = {
  name: string
  isWrite: boolean
  message: string
}

/**
 * Failures the run never recovered from. A tool that failed and later
 * succeeded — a retry that worked, a second call with better arguments — is
 * not held against the run. Repeats of the same tool collapse to one entry:
 * two timeouts of one search is one piece of missing evidence, not two.
 */
export function unrecoveredToolFailures(
  failures: readonly ToolFailure[],
  succeeded: ReadonlySet<string>,
): ToolFailure[] {
  const seen = new Set<string>()
  const out: ToolFailure[] = []
  for (const failure of failures) {
    if (succeeded.has(failure.name) || seen.has(failure.name)) continue
    seen.add(failure.name)
    out.push(failure)
  }
  return out
}

const describe = (failure: ToolFailure) => `${failure.name}: ${failure.message.slice(0, 200)}`

/**
 * The reason a run is 'blocked' rather than 'completed', or null. Only writes
 * block — the run genuinely failed to do the outbound thing it was asked to do.
 */
export function toolFailureBlockReason(unrecovered: readonly ToolFailure[]): string | null {
  const writes = unrecovered.filter((failure) => failure.isWrite)
  if (!writes.length) return null
  return `Not delivered — ${writes.map(describe).join(' ')}`
}

/**
 * Read failures worth telling the reader about on an otherwise finished run.
 * Writes are excluded: they are already the block reason, and saying it twice
 * reads as two separate problems.
 */
export function toolFailureWarnings(unrecovered: readonly ToolFailure[]): string[] {
  return unrecovered.filter((failure) => !failure.isWrite).map(describe)
}
