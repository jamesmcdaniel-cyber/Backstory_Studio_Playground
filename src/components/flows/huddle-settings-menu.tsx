'use client'

import { Settings } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { DeviceOption } from '@/lib/flows/audio-devices'

/**
 * Microphone and speaker selection. The speaker select is omitted entirely
 * where setSinkId is unsupported (Safari, Firefox) rather than shown inert.
 */
export function HuddleSettingsMenu({
  inputs,
  outputs,
  inputDeviceId,
  outputDeviceId,
  canSelectOutput,
  onSelectInput,
  onSelectOutput,
}: {
  inputs: DeviceOption[]
  outputs: DeviceOption[]
  inputDeviceId: string | null
  outputDeviceId: string | null
  canSelectOutput: boolean
  onSelectInput: (deviceId: string) => void
  onSelectOutput: (deviceId: string) => void
}) {
  if (inputs.length === 0 && outputs.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Audio settings"
          className="rounded-full border border-border/70 p-1.5 text-muted-foreground hover:text-foreground"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-64 p-3 text-xs">
        <label className="mb-1 block font-semibold text-foreground" htmlFor="huddle-mic">Microphone</label>
        <select
          id="huddle-mic"
          value={inputDeviceId ?? ''}
          onChange={(event) => onSelectInput(event.target.value)}
          className="mb-3 w-full rounded-md border border-border bg-background px-2 py-1"
        >
          {!inputDeviceId && <option value="">System default</option>}
          {inputs.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
        </select>
        {canSelectOutput && outputs.length > 0 && (
          <>
            <label className="mb-1 block font-semibold text-foreground" htmlFor="huddle-speaker">Speakers</label>
            <select
              id="huddle-speaker"
              value={outputDeviceId ?? ''}
              onChange={(event) => onSelectOutput(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-2 py-1"
            >
              {!outputDeviceId && <option value="">System default</option>}
              {outputs.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
            </select>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
