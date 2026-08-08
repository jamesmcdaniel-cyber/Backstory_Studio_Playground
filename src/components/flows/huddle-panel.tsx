'use client'

import { AlertCircle, Loader2, Mic, MicOff, NotebookPen, PhoneOff, Radio, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { HuddleMemberControls } from '@/components/flows/huddle-member-controls'
import { HuddleSettingsMenu } from '@/components/flows/huddle-settings-menu'
import type { FlowHuddle } from '@/lib/flows/use-flow-huddle'
import type { useHuddleCapture } from '@/lib/flows/use-huddle-capture'
import { cn } from '@/lib/utils'

export type HuddleMember = { clientId: string; name: string; color: string }

export type HuddleCapture = ReturnType<typeof useHuddleCapture>

/**
 * Every huddle control, living inside the Jam widget. Join / mic toggle /
 * leave are also promoted to the canvas's floating Huddle+Jam pill
 * (huddle-jam-pill.tsx), because voice has to be reachable in one action and
 * this panel sits behind a dialog; device pickers, per-peer volume, notes and
 * the relay explainer live only here.
 */
export function HuddlePanel({
  huddle,
  members,
  selfClientId,
  capture,
  captureAvailable,
}: {
  huddle: FlowHuddle
  /** Everyone whose presence says they're in the huddle, self included. */
  members: HuddleMember[]
  selfClientId: string
  /** Huddle-notes capture state; absent → the feature is not offered at all. */
  capture?: HuddleCapture
  /** Whether transcription is configured server-side. */
  captureAvailable?: boolean
}) {
  const { joined, connecting, muted, pttEnabled, transmitting, error, speakingIds, peerStates, peerAudio, relayAvailable } = huddle
  const live = members.length > 0
  // A lost peer with no TURN relay in play is almost always a strict NAT that
  // STUN can't traverse — say so, or "connection lost" reads as a random bug.
  const lostWithoutRelay = joined && relayAvailable === false
    && Array.from(peerStates.values()).some((state) => state === 'lost')

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
            <HuddleSettingsMenu
              inputs={huddle.devices.inputs}
              outputs={huddle.devices.outputs}
              inputDeviceId={huddle.inputDeviceId}
              outputDeviceId={huddle.outputDeviceId}
              canSelectOutput={huddle.canSelectOutput}
              onSelectInput={(id) => void huddle.selectInputDevice(id)}
              onSelectOutput={(id) => void huddle.selectOutputDevice(id)}
            />
            <Button size="sm" variant="destructive" className="h-7 rounded-full" onClick={huddle.leave} aria-label="Leave huddle">
              <PhoneOff className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
      </div>

      {capture && (joined || capture.summarizing) && (
        <div className="space-y-1.5 rounded-lg border border-border/60 bg-background/60 px-2.5 py-2">
          {joined && <div className="flex items-center justify-between gap-2">
            <span className={cn('flex items-center gap-1.5 text-[11px] font-medium', capture.captureLive ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground')}>
              <NotebookPen className="h-3.5 w-3.5" />
              {capture.captureLive ? 'Notes are being taken' : 'Take notes'}
              {capture.captureLive && <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-red-500" />}
            </span>
            {/* Whole-huddle switch: enable for anyone, disable only for the
                participant who started it (the session is theirs to end). */}
            {captureAvailable === false ? (
              <span className="text-[11px] text-muted-foreground">Transcription isn’t configured for this workspace.</span>
            ) : !capture.captureLive ? (
              <Button size="sm" variant="outline" className="h-6 rounded-full text-[11px]" onClick={capture.enableCapture}>
                Start notes
              </Button>
            ) : capture.isOwner ? (
              <Button size="sm" variant="outline" className="h-6 rounded-full text-[11px]" onClick={capture.disableCapture}>
                Stop notes
              </Button>
            ) : null}
          </div>}
          {joined && capture.captureLive && (
            <label className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
              {/* Personal consent: capture is local, so switching this off means
                  your audio never leaves this machine — not recorded-then-filtered. */}
              <span>Include my voice</span>
              <Switch checked={!capture.optedOut} onCheckedChange={(on) => capture.optOut(!on)} />
            </label>
          )}
          {capture.uploadWarning && (
            <p className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
              <AlertCircle className="h-3 w-3" /> Part of the conversation could not be saved.
              <button type="button" className="underline" onClick={capture.clearUploadWarning}>Dismiss</button>
            </p>
          )}
          {capture.summarizing && (
            <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Writing up notes…
            </p>
          )}
        </div>
      )}

      {lostWithoutRelay && (
        <p role="alert" className="flex items-start gap-1.5 rounded-lg border border-amber-300/60 bg-amber-50/60 px-2.5 py-2 text-[11px] text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            Couldn’t connect to someone in this huddle. Voice runs directly between
            computers, and this workspace has no relay for networks that block that —
            office networks and VPNs often do. An admin can fix this by connecting a
            voice relay (TURN).
          </span>
        </p>
      )}

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
