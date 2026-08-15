'use client'

import { AlertTriangle, Clock, ShieldAlert } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { CredentialStaleness } from '@/components/flows/http-credential-dialog'

/**
 * How long a stored secret has gone unrotated.
 *
 * Rotation was always possible here; nothing ever made it happen, because
 * nothing showed that a credential had sat untouched for two years. A badge on
 * the row someone is already looking at is the cheapest possible version of
 * that force — no report to run, no reminder to schedule.
 *
 * Fresh credentials render NOTHING. A badge on every row is wallpaper, and
 * wallpaper is exactly how the original problem persisted: the state was
 * technically visible and functionally invisible.
 */
export function StalenessBadge({ staleness }: { staleness?: CredentialStaleness | null }) {
  if (!staleness || staleness.level === 'fresh') return null

  const shape = {
    expired: { variant: 'risk' as const, icon: ShieldAlert, label: 'Expired' },
    stale: { variant: 'risk' as const, icon: AlertTriangle, label: 'Rotate' },
    aging: { variant: 'warn' as const, icon: Clock, label: 'Aging' },
  }[staleness.level]

  const Icon = shape.icon

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant={shape.variant}>
            <Icon className="mr-1 h-3 w-3" aria-hidden />
            {shape.label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{staleness.summary}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
