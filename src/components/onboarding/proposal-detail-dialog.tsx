'use client'

import { Check, UserPlus, X } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { proposalPersona } from '@/lib/templates/proposal-persona'
import { ProposalPreview, type ProposalCard } from './proposal-shared'

/**
 * The "little more detail" popup shared by the home Recommendations bar and the
 * notification bell. Dumb component — accept/dismiss are handled by the owner
 * (ProposalsProvider) so every surface stays in sync.
 */
export function ProposalDetailDialog({
  proposal,
  busy,
  onOpenChange,
  onAccept,
  onDismiss,
}: {
  proposal: ProposalCard | null
  busy: boolean
  onOpenChange: (open: boolean) => void
  onAccept: (proposal: ProposalCard) => void
  onDismiss: (proposal: ProposalCard) => void
}) {
  // Same persona the hiring desk row used, so the face, the chip, and the verb
  // are identical from the list to this popup to the button that commits it.
  const persona = proposal ? proposalPersona(proposal) : null
  return (
    <Dialog open={Boolean(proposal)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {proposal && (
          <>
            <DialogHeader>
              <div className="flex items-start gap-3">
                <AgentAvatar seed={persona!.seed} className="h-12 w-12 shrink-0 rounded-full ring-1 ring-black/5" />
                <div className="min-w-0">
                  <span
                    className={cn(
                      'inline-flex w-fit items-center rounded-md px-2 py-0.5 text-[11px] font-medium',
                      persona!.kind === 'applicant' ? 'bg-indigo-50 text-indigo-700' : 'bg-amber-50 text-amber-800',
                    )}
                  >
                    {persona!.chip}
                  </span>
                  <DialogTitle className="mt-1.5 text-base">{proposal.title}</DialogTitle>
                </div>
              </div>
            </DialogHeader>
            <p className="text-sm leading-6 text-gray-600">{proposal.rationale}</p>
            <ProposalPreview proposal={proposal} clamp={false} />
            <div className="mt-4 flex gap-2">
              <Button
                type="button"
                loading={busy}
                onClick={() => onAccept(proposal)}
                className="flex-1"
              >
                {!busy && (persona!.kind === 'applicant'
                  ? <UserPlus className="h-4 w-4" aria-hidden="true" />
                  : <Check className="h-4 w-4" aria-hidden="true" />)}
                {persona!.action}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => onDismiss(proposal)}
              >
                <X className="h-4 w-4" /> Dismiss
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
