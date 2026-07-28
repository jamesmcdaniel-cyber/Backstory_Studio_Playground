import { COACHING_SPECS } from './coaching'
import { PLATFORM_SPECS } from './platform'
import { REVENUE_SPECS } from './revenue'
import { STRATEGIC_SPECS } from './strategic'
import { OUTPUT_CONTRACT_MARKER, outputContract, report, type ReportSpec } from './report-builder'

/**
 * The advertised output of every built-in template, as a typed spec keyed by
 * template id. ONE spec drives two artifacts — the HTML the gallery renders
 * (`EXAMPLE_REPORTS`) and the instruction the agent runs against
 * (`EXAMPLE_OUTPUT_CONTRACTS`) — so what a template promises and what its agent
 * is told to produce cannot drift apart.
 */
export const EXAMPLE_SPECS: Record<string, ReportSpec> = {
  ...REVENUE_SPECS,
  ...COACHING_SPECS,
  ...PLATFORM_SPECS,
  ...STRATEGIC_SPECS,
}

const mapValues = <T>(fn: (spec: ReportSpec) => T): Record<string, T> =>
  Object.fromEntries(Object.entries(EXAMPLE_SPECS).map(([id, spec]) => [id, fn(spec)]))

/**
 * Illustrative output for every built-in template, keyed by template id.
 * Each one is a full house-format HTML report — the same document a live run
 * produces (src/features/agents/report-format.ts) — so what the gallery
 * advertises is exactly what the agent delivers.
 */
export const EXAMPLE_REPORTS: Record<string, string> = mapValues(report)

/**
 * The section-by-section delivery contract derived from each example, keyed by
 * template id. Appended to the template's instructions (see `withOutputContract`)
 * so the agent knows the exact shape its gallery example promises.
 */
export const EXAMPLE_OUTPUT_CONTRACTS: Record<string, string> = mapValues(outputContract)

/**
 * A built-in template's instructions plus the output contract for its example.
 * Idempotent, and a no-op for templates that advertise no example (nothing to
 * hold the run to).
 */
export function withOutputContract(templateId: string, instructions: string): string {
  const base = typeof instructions === 'string' ? instructions.trim() : ''
  const contract = EXAMPLE_OUTPUT_CONTRACTS[templateId]
  if (!contract || base.includes(OUTPUT_CONTRACT_MARKER)) return base
  return [base, contract].filter(Boolean).join('\n\n')
}

export { report, outputContract, actionPlan, high, med, num, dim, OUTPUT_CONTRACT_MARKER } from './report-builder'
export type { ReportSpec, Section, Cell } from './report-builder'
