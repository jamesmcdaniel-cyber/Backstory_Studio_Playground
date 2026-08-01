'use client'

import { AlertCircle, Headphones, Loader2, Mic, MicOff, PhoneOff, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { MediaErrorInfo } from '@/lib/flows/media-errors'
import { cn } from '@/lib/utils'

export type HuddleMember = { clientId: string; name: string; color: string }

/**
 * Floating voice-huddle controls, shown whenever a huddle is live (self or
 * teammates in it): join/leave, mute, and member avatars with a speaking
 * pulse. Sits bottom-center over the canvas.
 */
export function HuddleBar({
  joined,
  connecting,
  muted,
  members,
  speakingIds,
  error,
  onJoin,
  onLeave,
  onToggleMute,
  onDismissError,
}: {
  joined: boolean
  connecting: boolean
  muted: boolean
  /** Everyone currently in the huddle (including self when joined). */
  members: HuddleMember[]
  speakingIds: Set<string>
  error?: MediaErrorInfo | null
  onJoin: () => void
  onLeave: () => void
  onToggleMute: () => void
  onDismissError?: () => void
}) {
  // `!error` matters: the FIRST person to start a huddle does so from the jam
  // dialog while `members` is still empty, so a denied mic leaves both `joined`
  // and `members` empty — without this the message would be hidden in exactly
  // the case it exists for.
  if (!joined && members.length === 0 && !error) return null
  return (
    <div className="absolute bottom-4 left-1/2 z-40 flex -translate-x-1/2 flex-col items-center gap-2">
      {error && (
        <div role="alert" className="flex max-w-sm items-start gap-2 rounded-lg border border-destructive/40 bg-background/95 px-3 py-2 shadow-lg backdrop-blur">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="text-xs">
            <p className="font-semibold text-foreground">{error.title}</p>
            <p className="text-muted-foreground">{error.hint}</p>
          </div>
          <button type="button" onClick={onDismissError} aria-label="Dismiss" className="ml-1 text-muted-foreground hover:text-foreground">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {(joined || members.length > 0) && (
        <div className="flex items-center gap-2 rounded-full border border-border bg-background/95 px-3 py-2 shadow-lg backdrop-blur">
          <span className="flex items-center gap-1.5 pr-1 text-xs font-semibold text-muted-foreground">
            <Headphones className="h-3.5 w-3.5" /> Huddle
          </span>
          <div className="flex items-center -space-x-1.5">
            {members.slice(0, 6).map((member) => (
              <span
                key={member.clientId}
                title={member.name}
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-full border-2 border-background text-[10px] font-semibold text-white transition-shadow',
                  speakingIds.has(member.clientId) && 'ring-2 ring-emerald-400',
                )}
                style={{ backgroundColor: member.color }}
              >
                {member.name.trim().charAt(0).toUpperCase() || '?'}
              </span>
            ))}
            {members.length > 6 && (
              <span className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-background bg-muted text-[10px] font-semibold text-muted-foreground">
                +{members.length - 6}
              </span>
            )}
          </div>
          {joined ? (
            <>
              <Button variant={muted ? 'default' : 'outline'} size="sm" className="rounded-full" onClick={onToggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
                {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              </Button>
              <Button variant="destructive" size="sm" className="rounded-full" onClick={onLeave} aria-label="Leave huddle">
                <PhoneOff className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <Button size="sm" className="rounded-full" onClick={onJoin} disabled={connecting}>
              {connecting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Mic className="mr-1.5 h-4 w-4" />} Join
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
