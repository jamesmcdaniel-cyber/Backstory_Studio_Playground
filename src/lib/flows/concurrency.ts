/** Only full-graph replacements need optimistic concurrency protection. */
export function shouldGuardFlowWrite(input: {
  graph: unknown
  baseUpdatedAt?: string
}): boolean {
  return input.graph !== undefined && Boolean(input.baseUpdatedAt)
}
