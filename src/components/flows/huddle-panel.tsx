'use client'

import { AlertCircle, Loader2, Mic, MicOff, PhoneOff, Radio, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HuddleMemberControls } from '@/components/flows/huddle-member-controls'
import type { FlowHuddle } from '@/lib/flows/use-flow-huddle'
import { cn } from '@/lib/utils'

export type HuddleMember = { clientId: string; name: string; color: string }

/**
 * Every huddle control, living inside the Jam widget — there is deliberately no
 * separate floating huddle surface. Only the mute toggle is promoted out of
 * here (to the header's Jam button), because muting has to be reachable in one
 * action and this panel sits behind a dialog.
 */
export function HuddlePanel({
  huddle,
  members,
  selfClientId,
}: {
  huddle: FlowHuddle
  /** Everyone whose presence says they're in the huddle, self included. */
  members: HuddleMember[]
  selfClientId: string
}) {
  const { joined, connecting, muted, pttEnabled, transmitting, error, speakingIds, peerStates, peerAudio } = huddle
  const live = members.length > 0

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {!joined ? (
          <Button size="sm" variant="outline" className="h-7 rounded-full" onClick={() => void huddle.join()} disabled={connecting}>
            {connecting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Mic className="mr-1.5 h-3.5 w-3.5" />}
            {live ? 'Join huddle' : 'Start huddle'}
          </Button>
        ) : (
          <>
            {/* Push-to-talk stands IN PLACE OF mute here — two competing mute
                concepts side by side is how people lose track of their state. */}
            {pttEnabled ? (
              <Button
                size="sm"
                variant={transmitting ? 'default' : 'outline'}
                className="h-7 rounded-full"
                onClick={() => huddle.setPttEnabled(false)}
                aria-label="Turn off push to talk"
              >
                <Radio className={cn('mr-1.5 h-3.5 w-3.5', transmitting && 'animate-pulse')} />
                {transmitting ? 'Live' : 'Hold Space'}
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant={muted ? 'default' : 'outline'}
                  className="h-7 rounded-full"
                  onClick={huddle.toggleMute}
                  aria-label={muted ? 'Unmute' : 'Mute'}
                >
                  {muted ? <MicOff className="mr-1.5 h-3.5 w-3.5" /> : <Mic className="mr-1.5 h-3.5 w-3.5" />}
                  {muted ? 'Muted' : 'Mic on'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 rounded-full"
                  onClick={() => huddle.setPttEnabled(true)}
                  aria-label="Turn on push to talk"
                  title="Hold Space to speak"
                >
                  <Radio className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
            <Button size="sm" variant="destructive" className="h-7 rounded-full" onClick={huddle.leave} aria-label="Leave huddle">
              <PhoneOff className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-background/80 px-2.5 py-2">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
          <div className="min-w-0 text-[11px]">
            <p className="font-semibold text-foreground">{error.title}</p>
            <p className="text-muted-foreground">{error.hint}</p>
          </div>
          <button type="button" onClick={huddle.clearError} aria-label="Dismiss" className="ml-auto shrink-0 text-muted-foreground hover:text-foreground">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {live && (
        <div className="flex items-center -space-x-1.5">
          {members.map((member) => {
            const state = peerStates.get(member.clientId)
            const avatar = (
              <span
                title={
                  state === 'reconnecting' ? `${member.name} — reconnecting`
                  : state === 'lost' ? `${member.name} — connection lost`
                  : member.name
                }
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-full border-2 border-background text-[10px] font-semibold text-white transition-shadow',
                  speakingIds.has(member.clientId) && 'ring-2 ring-emerald-400',
                  state === 'reconnecting' && 'opacity-50 animate-pulse',
                  state === 'lost' && 'opacity-40 grayscale',
                )}
                style={{ backgroundColor: member.color }}
              >
                {member.name.trim().charAt(0).toUpperCase() || '?'}
              </span>
            )
            // No playback controls for yourself — you can't turn your own
            // volume down, and offering it would only confuse.
            if (member.clientId === selfClientId) return <span key={member.clientId}>{avatar}</span>
            return (
              <HuddleMemberControls
                key={member.clientId}
                name={member.name}
                settings={peerAudio.get(member.clientId) ?? { volume: 1, muted: false }}
                onChange={(patch) => huddle.setPeerAudio(member.clientId, patch)}
              >
                <button type="button" className="rounded-full" aria-label={`Audio for ${member.name}`}>
                  {avatar}
                </button>
              </HuddleMemberControls>
            )
          })}
        </div>
      )}
    </div>
  )
}
