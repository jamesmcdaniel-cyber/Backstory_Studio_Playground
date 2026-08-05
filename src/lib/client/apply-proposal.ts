'use client'

import { toast } from 'sonner'

/**
 * What the accept route reports back, and where the client sends the user next.
 *
 * Every surface that applies a recommendation (the notification bell, the home
 * recommendations bar, the connect-flow inbox) shares this so they cannot drift:
 * an applied recommendation ALWAYS either opens the live artifact it created or
 * says plainly that it could not create one. The old per-surface copies treated
 * any 2xx as success and toasted "Added to your catalogue", so a failed
 * provisioning read as "Apply did nothing" — the recommendation was consumed and
 * nothing appeared in the workspace.
 */
export type AcceptResponse = {
  status?: string
  kind?: string
  templateId?: string | null
  agentId?: string | null
  flowId?: string | null
  /** false when the server created the template but no live artifact. */
  provisioned?: boolean
  missingIntegrations?: unknown
  open?: { targetType?: string; targetId?: string } | null
}

export type AcceptOutcome =
  /** Full navigation to the artifact that was just created. */
  | { action: 'navigate'; href: string; message: string }
  /** A side trip to something that already existed — opened alongside. */
  | { action: 'open'; href: string | null; message: string }
  /** Nothing live was created; say so rather than claiming success. */
  | { action: 'failed'; message: string }

const asId = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

/**
 * Decide where an accepted recommendation lands. Pure, so the "applied but
 * nothing was built" case is unit-testable without a DOM.
 */
export function acceptOutcome(proposalKind: string, data: AcceptResponse): AcceptOutcome {
  if (proposalKind === 'process_improvement') {
    const targetId = asId(data.open?.targetId)
    const targetType = data.open?.targetType
    const href = targetId && targetType === 'flow'
      ? `/flows/${targetId}`
      : targetId && targetType === 'agent'
        ? `/agents?agent=${targetId}`
        : null
    return { action: 'open', href, message: 'Opened what it wants to improve.' }
  }

  // 1-click: accept provisioned a LIVE artifact — land the user on it.
  const agentId = asId(data.agentId)
  if (agentId) {
    const missing = Array.isArray(data.missingIntegrations) ? (data.missingIntegrations as string[]) : []
    return {
      action: 'navigate',
      href: `/agents?agent=${agentId}`,
      message: missing.length
        ? `Agent created — connect ${missing.join(', ')} to fully activate it.`
        : 'Agent created and ready to run.',
    }
  }
  const flowId = asId(data.flowId)
  if (flowId) {
    return { action: 'navigate', href: `/flows/${flowId}`, message: 'Flow created and wired — ready to run.' }
  }
  return { action: 'failed', message: "Couldn't build this one — it's saved in your templates. Please try again." }
}

/** Land the user on whatever accepting a recommendation actually built. */
export function landOnAcceptedProposal(proposalKind: string, data: AcceptResponse): void {
  const outcome = acceptOutcome(proposalKind, data)
  if (outcome.action === 'failed') {
    toast.error(outcome.message)
    return
  }
  toast.success(outcome.message)
  if (outcome.action === 'open') {
    if (outcome.href) window.open(outcome.href, '_blank', 'noopener')
    return
  }
  window.location.href = outcome.href
}
