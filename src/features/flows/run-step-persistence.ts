import { prisma } from '@/lib/prisma'
// Node types whose FlowRunStep rows are written by the execute-flow ADAPTERS
// (create-at-start + finish-at-end, so the run panel shows live status). The
// interpreter's onStep must skip these or every such step gets a duplicate
// row. Any node type dispatched through runAgent/runAction belongs here —
// including 'knowledge', whose omission double-persisted every knowledge step
// (one adapter row + one interpreter row with an empty input).
const ADAPTER_PERSISTED_TYPES = new Set(['agent', 'tool', 'http', 'ai', 'subflow', 'code', 'knowledge'])

export function shouldPersistInterpreterStep(nodeType: string | undefined): boolean {
  return !nodeType || !ADAPTER_PERSISTED_TYPES.has(nodeType)
}

/**
 * A code step executes with the WHOLE run context (context.steps = every prior
 * step's output) — but persisting that copy made step rows quadratic in run
 * size and duplicated the data already on each step's own row. The persisted
 * input keeps everything the code actually declared plus the small context
 * scalars, and replaces context.steps with an omission marker.
 */
export function persistedCodeStepInput(config: Record<string, unknown>): Record<string, unknown> {
  const context = config.context
  if (!context || typeof context !== 'object' || Array.isArray(context)) return config
  return {
    ...config,
    context: {
      ...(context as Record<string, unknown>),
      steps: '[the executed input contained the full prior-step context (steps.*) — elided at persistence; see each step’s own row]',
    },
  }
}

// ─── moved from execute-flow.ts ───────────────────────────────────────────
// Small helpers shared by the engine and the action-step executor it was
// carved into (./run-action-step). They live here rather than being exported
// from execute-flow.ts so the two modules do not import each other: the only
// genuine cycle between them is the subflow recursion, which is deliberately
// a dynamic import at its call site.

/** Bound HTTP responses so downstream prompts/logs stay manageable. */
export const HTTP_MAX_RESPONSE_CHARS = 50_000

/** Best-effort download filename: Content-Disposition, else the URL's last path
 *  segment, else a generic name. */
export function httpDownloadFilename(contentDisposition: string | null, url: string): string {
  const match = contentDisposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]).replace(/[\r\n/\\]/g, ' ').trim().slice(0, 200) || 'download'
    } catch {
      return match[1].replace(/[\r\n/\\]/g, ' ').trim().slice(0, 200) || 'download'
    }
  }
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).at(-1)
    if (segment) return decodeURIComponent(segment).slice(0, 200)
  } catch {
    /* fall through */
  }
  return 'download'
}

export function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

/**
 * Retry evidence is only evidence when a retry actually happened. `retries:0`
 * (or any chain that fails on its very first and only attempt) still yields
 * one `attemptErrors` entry — persisting it would just duplicate the `error`
 * field verbatim. Gate on `attempts > 1` (more than one call was actually
 * made) rather than `attemptErrors.length` (which is 1 for that no-retry
 * case too).
 */
export function retryWarnings(attempts: number, attemptErrors: string[]): string[] {
  return attempts > 1 ? attemptErrors : []
}

/** What a paused child flow is asking, for the parent's waiting banner. */
export async function subflowChildQuestion(childRunId: string, childName: string): Promise<string> {
  // FlowRunStep is transitively org-scoped (no organizationId column); the
  // child run id comes from this run's own org-scoped write, so a bare
  // flowRunId read cannot cross tenants.
  const waitingStep = await prisma.flowRunStep.findFirst({
    where: { flowRunId: childRunId, status: 'waiting' },
    orderBy: { order: 'desc' },
  }).catch(() => null)
  const question = (waitingStep?.output as { waiting?: { question?: string } } | null)?.waiting?.question
  return question ? `${childName}: ${question}` : `"${childName}" paused to ask for input.`
}
