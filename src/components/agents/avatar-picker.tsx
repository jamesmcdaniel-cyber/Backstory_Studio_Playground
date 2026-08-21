'use client'

import { useState } from 'react'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AVATAR_ASSETS, avatarAssetIndex } from '@/lib/agents/avatar-assets'
import { cn } from '@/lib/utils'

/**
 * Pick a face.
 *
 * Existing arbitrary seeds resolve deterministically into the authored library;
 * new selections persist the stable asset ID. Choosing the portrait associated
 * with the entity's base seed stores null, preserving the reset behavior.
 */
export function AvatarPicker({
  /** Identity of the thing being dressed — used for its deterministic default. */
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
  const [choice, setChoice] = useState<string | null>(current)
  const selectedIndex = avatarAssetIndex(choice ?? baseSeed)
  const baseIndex = avatarAssetIndex(baseSeed)

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-2xl overflow-hidden p-0">
        <div className="border-b bg-gradient-to-br from-indigo-50 via-white to-violet-50 px-6 pb-5 pt-6">
          <DialogHeader>
            <DialogTitle>Choose an avatar</DialogTitle>
            <DialogDescription>Choose a look for your teammate. You can change it any time.</DialogDescription>
          </DialogHeader>

          <div className="mt-5 flex items-center gap-4 rounded-2xl border border-white/80 bg-white/70 p-3 shadow-sm backdrop-blur-sm">
            <AgentAvatar seed={choice || baseSeed} className="h-24 w-20 shrink-0 rounded-2xl shadow-md ring-1 ring-black/[0.06]" />
            <div>
              <p className="text-sm font-semibold text-foreground">Your current pick</p>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">A dimensional 3D profile that stays consistent across your workspace.</p>
            </div>
          </div>
        </div>

        <div className="grid max-h-[50vh] grid-cols-4 gap-3 overflow-y-auto px-6 py-5 sm:grid-cols-6">
          {AVATAR_ASSETS.map((asset, index) => {
            const selected = selectedIndex === index
            return (
              <button
                key={asset.id}
                type="button"
                onClick={() => setChoice(index === baseIndex ? null : asset.id)}
                aria-label={`Choose ${asset.label} avatar`}
                aria-pressed={selected}
                className={cn(
                  'group/avatar relative rounded-2xl border bg-slate-50/70 p-1.5 transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300',
                  selected
                    ? 'border-indigo-500 bg-indigo-50 shadow-[0_5px_16px_-8px_rgba(79,70,229,0.8)] ring-1 ring-indigo-500'
                    : 'border-gray-200/80 hover:-translate-y-0.5 hover:border-indigo-200 hover:bg-white hover:shadow-md',
                )}
              >
                <AgentAvatar seed={asset.id} className="h-auto w-full rounded-xl shadow-sm transition-transform duration-150 group-hover/avatar:scale-[1.03]" />
                {selected && (
                  <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-indigo-600 text-[10px] font-bold text-white ring-2 ring-white" aria-hidden="true">✓</span>
                )}
              </button>
            )
          })}
        </div>

        <div className="flex items-center justify-between gap-2 border-t bg-slate-50/60 px-6 py-4">
          <p className="text-xs text-muted-foreground">24 original portraits</p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onCancel} disabled={saving}>Cancel</Button>
            <Button onClick={() => onSelect(choice)} loading={saving}>Save</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
