'use client'

import { Volume2, VolumeX } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { PeerAudioSettings } from '@/lib/flows/use-flow-huddle'
import { cn } from '@/lib/utils'

/**
 * Per-member playback controls, local to this listener — muting someone here
 * silences them for you only and is never broadcast, which is why the popover
 * says so explicitly.
 */
export function HuddleMemberControls({
  name,
  settings,
  onChange,
  children,
}: {
  name: string
  settings: PeerAudioSettings
  onChange: (patch: Partial<PeerAudioSettings>) => void
  children: React.ReactNode
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-56 p-3">
        <p className="mb-2 truncate text-xs font-semibold text-foreground">{name}</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onChange({ muted: !settings.muted })}
            aria-label={settings.muted ? `Unmute ${name} for me` : `Mute ${name} for me`}
            className={cn('shrink-0 text-muted-foreground hover:text-foreground', settings.muted && 'text-destructive')}
          >
            {settings.muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.volume}
            disabled={settings.muted}
            aria-label={`Volume for ${name}`}
            onChange={(event) => onChange({ volume: Number(event.target.value) })}
            className="h-1 w-full accent-indigo-500"
          />
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">Only affects what you hear.</p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
