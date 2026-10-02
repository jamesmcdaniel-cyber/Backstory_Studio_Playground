'use client'

import { createContext, useContext } from 'react'
import type { ProposalCard } from '@/components/onboarding/proposal-shared'

export type ProposalsContextValue = {
  proposals: ProposalCard[]
  loaded: boolean
  busyId: string | null
  accept: (proposal: ProposalCard) => Promise<void>
  dismiss: (proposal: ProposalCard) => Promise<void>
  openDetail: (proposal: ProposalCard) => void
}

export const ProposalsContext = createContext<ProposalsContextValue | null>(null)
export function useOptionalProposals() { return useContext(ProposalsContext) }
