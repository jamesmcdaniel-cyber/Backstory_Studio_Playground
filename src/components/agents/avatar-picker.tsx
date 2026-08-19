'use client'

import { useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

/** How many faces to offer at once — a screenful, not a catalogue. */
const PAGE_SIZE = 12

/**
 * Pick a face.
 *
 * Avatars are derived from a seed string rather than stored as images, so
 * choosing one means choosing a seed. The grid is a deterministic walk through
 * seed space (`<base>#<n>`), which means Shuffle can page forward forever
 * without a library of assets and the same page always renders the same faces.
 */
export function AvatarPicker({
  /** Identity of the thing being dressed — the fallback seed, and page 0's first face. */
  baseSeed,
  current,
  onCancel,
  onSelect,
  saving,
}: {
  baseSeed: string
  current: string | null
  onCancel: () => void
  onSelect: (seed: string | null) => void
  saving: boolean
}) {
  const [page, setPage] = useState(0)
  const [choice, setChoice] = useState<string | null>(current)

  const seeds = useMemo(() => {
    // Page 0 leads with the bare id so "the original face" is always offered
    // back, which is the only way to undo a choice without a reset button.
    const offset = page * PAGE_SIZE
    return Array.from({ length: PAGE_SIZE }, (_, index) => {
      const n = offset + index
      return n === 0 ? baseSeed : `${baseSeed}#${n}`
    })
  }, [baseSeed, page])

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Choose an avatar</DialogTitle>
          <DialogDescription>Pick the face that shows on the roster.</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
          {seeds.map((seed) => {
            const selected = (choice ?? baseSeed) === seed
            return (
              <button
                key={seed}
                type="button"
                onClick={() => setChoice(seed === baseSeed ? null : seed)}
                aria-label={`Avatar option ${seed}`}
                aria-pressed={selected}
                className={cn(
                  'rounded-full p-0.5 transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300',
                  selected ? 'ring-2 ring-indigo-500' : 'hover:ring-2 hover:ring-indigo-200',
                )}
              >
                <AgentAvatar seed={seed} className="h-12 w-12 rounded-full" />
              </button>
            )
          })}
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          <Button variant="ghost" onClick={() => setPage((current_) => current_ + 1)} disabled={saving}>
            <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden="true" /> Shuffle
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onCancel} disabled={saving}>Cancel</Button>
            <Button onClick={() => onSelect(choice)} loading={saving}>Save</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
