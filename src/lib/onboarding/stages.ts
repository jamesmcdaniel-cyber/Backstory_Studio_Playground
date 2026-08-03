import { isCustomerEdition } from '@/lib/edition'

const INTERNAL_STAGES = ['Connect your tools', 'Your data takes shape', 'Your AI goes live'] as const
// No "Your data takes shape": that stage IS the AI proposal inbox, and the
// customer edition generates no proposals. An empty middle step would promise
// something that never arrives.
const CUSTOMER_STAGES = ['Connect your tools', 'Your AI goes live'] as const

export function onboardingStages(): readonly string[] {
  return isCustomerEdition() ? CUSTOMER_STAGES : INTERNAL_STAGES
}

/** Index of the final "Your AI goes live" stage. */
export function liveStageIndex(): number {
  return onboardingStages().length - 1
}

/**
 * The furthest stage the user may open; they can always look back.
 *
 * The 3-integration gate exists ONLY to gate template generation, so the
 * customer edition ignores it — keeping it would block customers behind a meter
 * that unlocks nothing.
 */
export function unlockedStage({ entitlementDone, meetsGate }: { entitlementDone: boolean; meetsGate: boolean }): number {
  if (!entitlementDone) return 0
  if (isCustomerEdition()) return liveStageIndex()
  return meetsGate ? 2 : 1
}

/**
 * Whether a fully-onboarded visitor should be forwarded to the dashboard.
 *
 * The customer edition must NOT wait on `openProposals`: nothing fetches it, so
 * it stays null forever and onboarding would hang on the stepper.
 */
export function shouldForwardToDashboard({
  entitlementDone,
  meetsGate,
  openProposals,
}: {
  entitlementDone: boolean
  meetsGate: boolean
  openProposals: number | null
}): boolean {
  if (!entitlementDone) return false
  if (isCustomerEdition()) return true
  return meetsGate && openProposals === 0
}
