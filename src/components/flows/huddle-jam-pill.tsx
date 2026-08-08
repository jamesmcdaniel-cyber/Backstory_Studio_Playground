'use client'

import { Headphones, Loader2, Mic, MicOff, PhoneOff, Radio, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { FlowHuddle } from '@/lib/flows/use-flow-huddle'
import { cn } from '@/lib/utils'

/**
 * The floating Huddle / Jam pill, top-center of the flow canvas — the one
 * voice-and-people surface outside the Jam dialog.
 *
 * Huddle is a single action for voice: join when out, mic toggle when in
 * (push-to-talk state hands off to the dialog, same as everywhere else —
 * two competing mute concepts side by side is how people lose track of
 * their state). Jam opens the dialog for inviting people; its dot carries
 * flow + jam health. Green = runs dispatch and the live channel is up;
 * amber = live channel reconnecting; red = execution backend offline, a
 * run stranded, or the channel refused. Specifics live in the tooltip.
 *
 * Starting a huddle is gated (startBlocked) until someone else is jamming
 * and the dot is green — voice with nobody to hear it is a mic left open.
 * Joining a huddle that's already live is never gated. The blocked button
 * stays hoverable (aria-disabled, not disabled) so the tooltip can say why.
 */
export function HuddleJamPill({
  huddle,
  huddleCount,
  othersCount,
  dotLevel,
  startBlocked,
  healthTitle,
  onOpenJam,
}: {
  huddle: FlowHuddle
  /** Everyone whose presence says they're in the huddle, self included. */
  huddleCount: number
  /** Collaborators present besides self. */
  othersCount: number
  dotLevel: 'ok' | 'reconnecting' | 'degraded'
  /** Why a huddle can't be STARTED right now, or null when it can. */
  startBlocked: string | null
  healthTitle: string
  onOpenJam: () => void
}) {
  const { joined, connecting, muted, pttEnabled, transmitting } = huddle
  const liveElsewhere = !joined && huddleCount > 0
  const blocked = !joined && !liveElsewhere && startBlocked != null

  return (
    // animate-fade-in only: the -up variant animates `transform`, which would
    // stomp this pill's centering -translate-x-1/2 mid-animation.
    <div className="pointer-events-auto absolute left-1/2 top-4 z-30 flex -translate-x-1/2 animate-fade-in items-center gap-1 rounded-full border border-border bg-background/95 p-1 shadow-3 backdrop-blur">
      {!joined ? (
        <Button
          size="sm"
          variant="ghost"
          className={cn('h-7 rounded-full', blocked && 'cursor-not-allowed opacity-50 hover:bg-transparent')}
          onClick={() => { if (!blocked) void huddle.join() }}
          disabled={connecting}
          aria-disabled={connecting || blocked}
          title={blocked ? startBlocked ?? undefined : liveElsewhere ? 'Join the live huddle' : 'Start a huddle — your mic goes live'}
        >
          {connecting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Headphones className="mr-1.5 h-4 w-4" />}
          Huddle
          {liveElsewhere && (
            <span className="ml-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-600 px-1 text-[10px] font-semibold text-white">
              {huddleCount}
            </span>
          )}
        </Button>
      ) : (
        <>
          {pttEnabled ? (
            <Button
              size="sm"
              variant={transmitting ? 'default' : 'ghost'}
              className="h-7 rounded-full"
              onClick={onOpenJam}
              title="Push to talk is on — hold Space to speak"
            >
              <Radio className={cn('mr-1.5 h-4 w-4', transmitting && 'animate-pulse')} />
              {transmitting ? 'Live' : 'Hold Space'}
            </Button>
          ) : (
            <Button
              size="sm"
              variant={muted ? 'default' : 'ghost'}
              className={cn('h-7 rounded-full', !muted && 'text-emerald-700 hover:text-emerald-700')}
              onClick={huddle.toggleMute}
              aria-label={muted ? 'Unmute' : 'Mute'}
            >
              {muted ? <MicOff className="mr-1.5 h-4 w-4" /> : <Mic className="mr-1.5 h-4 w-4" />}
              Huddle
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 rounded-full p-0 text-muted-foreground hover:text-red-600"
            onClick={huddle.leave}
            aria-label="Leave huddle"
          >
            <PhoneOff className="h-4 w-4" />
          </Button>
        </>
      )}
      <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border" />
      <Button size="sm" variant="ghost" className="h-7 rounded-full" onClick={onOpenJam} title={healthTitle}>
        <span
          role="status"
          aria-label={dotLevel === 'degraded' ? 'Flow or jam health degraded' : dotLevel === 'reconnecting' ? 'Jam reconnecting' : 'Flows and jam healthy'}
          className={cn(
            'mr-1.5 h-2 w-2 rounded-full',
            dotLevel === 'degraded' ? 'bg-red-500' : dotLevel === 'reconnecting' ? 'bg-amber-500' : 'bg-emerald-500',
          )}
        />
        <UserPlus className="mr-1.5 h-4 w-4" /> Jam
        {othersCount > 0 && (
          <span className="ml-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-indigo-600 px-1 text-[10px] font-semibold text-white">
            {othersCount}
          </span>
        )}
      </Button>
    </div>
  )
}
