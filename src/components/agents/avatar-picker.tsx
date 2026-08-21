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
      <DialogContent className="max-w-lg overflow-hidden p-0">
        <div className="border-b bg-gradient-to-br from-indigo-50 via-white to-violet-50 px-6 pb-5 pt-6">
          <DialogHeader>
            <DialogTitle>Choose an avatar</DialogTitle>
            <DialogDescription>Choose a look for your teammate. You can change it any time.</DialogDescription>
          </DialogHeader>

          <div className="mt-5 flex items-center gap-4 rounded-2xl border border-white/80 bg-white/70 p-3 shadow-sm backdrop-blur-sm">
            <AgentAvatar seed={choice || baseSeed} className="h-16 w-16 shrink-0 rounded-full shadow-md" />
            <div>
              <p className="text-sm font-semibold text-foreground">Your current pick</p>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">A crisp, illustrated profile that stays consistent across your workspace.</p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-3 px-6 py-5 sm:grid-cols-6">
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
                  'group/avatar relative rounded-2xl border bg-slate-50/70 p-1.5 transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300',
                  selected
                    ? 'border-indigo-500 bg-indigo-50 shadow-[0_5px_16px_-8px_rgba(79,70,229,0.8)] ring-1 ring-indigo-500'
                    : 'border-gray-200/80 hover:-translate-y-0.5 hover:border-indigo-200 hover:bg-white hover:shadow-md',
                )}
              >
                <AgentAvatar seed={seed} className="h-auto w-full rounded-full shadow-sm transition-transform duration-150 group-hover/avatar:scale-[1.03]" />
                {selected && (
                  <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-indigo-600 text-[10px] font-bold text-white ring-2 ring-white" aria-hidden="true">✓</span>
                )}
              </button>
            )
          })}
        </div>

        <div className="flex items-center justify-between gap-2 border-t bg-slate-50/60 px-6 py-4">
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
