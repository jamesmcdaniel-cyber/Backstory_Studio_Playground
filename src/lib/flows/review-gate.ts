/**
 * Who may publish a flow, and when.
 *
 * Our approvals have always been RUNTIME gates: a running agent pauses before a
 * write. Nothing reviewed a flow DEFINITION before it went live — and a
 * published flow runs on a schedule, against real customer systems, with nobody
 * watching. We are careful about who IS an owner and were casual about what an
 * owner could ship unreviewed.
 *
 * Pure, so the rule is one readable function rather than a condition spread
 * through the publish route. The route owns the database; this owns the policy.
 */

export type ReviewPolicy = {
  /** Workspace setting. Off by default — see the migration for why. */
  required: boolean
}

export type ReviewState = {
  status: 'open' | 'approved' | 'rejected' | 'withdrawn'
  requestedBy: string
  decidedBy?: string | null
  /** SHA of the graph that was reviewed, to catch edits made after approval. */
  graphFingerprint?: string | null
}

export type PublishDecision =
  | { allowed: true }
  | { allowed: false; reason: 'review_required'; message: string }
  | { allowed: false; reason: 'review_pending'; message: string }
  | { allowed: false; reason: 'review_rejected'; message: string }
  | { allowed: false; reason: 'review_stale'; message: string }

/**
 * May this person publish this draft right now?
 *
 * `currentFingerprint` is the draft as it stands. An approval is of a specific
 * draft, not of a flow forever: editing after approval and then publishing
 * would ship something nobody read, which is the failure mode a review process
 * exists to prevent.
 */
export function canPublish(params: {
  policy: ReviewPolicy
  actorUserId: string
  review: ReviewState | null
  currentFingerprint: string
}): PublishDecision {
  if (!params.policy.required) return { allowed: true }

  const review = params.review
  if (!review || review.status === 'withdrawn') {
    return {
      allowed: false,
      reason: 'review_required',
      message: 'This workspace reviews flows before they go live. Ask a colleague to approve this change.',
    }
  }

  if (review.status === 'open') {
    return {
      allowed: false,
      reason: 'review_pending',
      message: 'This change is waiting for a review.',
    }
  }

  if (review.status === 'rejected') {
    return {
      allowed: false,
      reason: 'review_rejected',
      message: 'This change was not approved. Make the requested changes and ask for another review.',
    }
  }

  if (review.graphFingerprint && review.graphFingerprint !== params.currentFingerprint) {
    return {
      allowed: false,
      reason: 'review_stale',
      message: 'The flow changed after it was approved. Ask for a review of the current version.',
    }
  }

  return { allowed: true }
}

/**
 * May this person decide this review?
 *
 * Never its author. A review you can approve yourself is not a review, and the
 * whole point of the gate is a second pair of eyes — so this holds even for an
 * owner, who can otherwise do anything in the workspace.
 */
export function canDecideReview(review: Pick<ReviewState, 'requestedBy' | 'status'>, actorUserId: string): {
  allowed: boolean
  message?: string
} {
  if (review.status !== 'open') {
    return { allowed: false, message: 'This review has already been decided.' }
  }
  if (review.requestedBy === actorUserId) {
    return { allowed: false, message: 'A change has to be approved by someone other than the person who made it.' }
  }
  return { allowed: true }
}

/**
 * Whether a workspace can operate the gate at all.
 *
 * A single-member workspace turning this on would lock itself out of
 * publishing entirely — nobody else exists to approve. Refused at the point the
 * policy is set rather than discovered at the point someone tries to ship.
 */
export function canEnableReviewPolicy(activeMemberCount: number): { allowed: boolean; message?: string } {
  if (activeMemberCount >= 2) return { allowed: true }
  return {
    allowed: false,
    message: 'Reviews need someone else to approve them. Invite a colleague first.',
  }
}
