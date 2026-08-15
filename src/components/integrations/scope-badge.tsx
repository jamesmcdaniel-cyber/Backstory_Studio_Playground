'use client'

import { AlertTriangle, PencilLine, ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * What a connection was actually granted, shown where the connection is
 * managed.
 *
 * Scopes were previously invisible in the product: a read-only integration and
 * one holding full write access looked identical on this page, so "are scopes
 * minimized?" could only be answered by logging into each provider's dashboard
 * one at a time. The point of surfacing it here is that over-broad access
 * becomes something you notice while doing something else, rather than
 * something you have to go looking for.
 */

export interface ScopeReviewView {
  granted: string[]
  writeScopes: string[]
  excessScopes: string[]
  policyDeclared: boolean
  permitted: boolean
  needsReview: boolean
}

export function ScopeBadge({ review }: { review?: ScopeReviewView | null }) {
  const shape = describe(review)

  return (
    // Mounted here rather than relying on an ancestor: the only TooltipProviders
    // in the app are inside the sidebar and the auth gateway, so a badge dropped
    // into any other surface would render a tooltip that never opens.
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant={shape.variant}>
            {shape.icon}
            {shape.label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{shape.detail}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function describe(review?: ScopeReviewView | null) {
  // Absent or empty is NOT "no access" — it is "we have not observed the grant
  // yet" (connections created before scopes were recorded, or a Nango
  // connection not yet verified). Saying "None" here would be a confident lie
  // about the one thing this badge exists to report.
  if (!review || review.granted.length === 0) {
    return {
      variant: 'secondary' as const,
      icon: null,
      label: 'Scopes not recorded',
      detail: (
        <p>
          The granted scopes have not been observed for this connection yet. Reconnect or verify it
          to record them.
        </p>
      ),
    }
  }

  const { granted, writeScopes, excessScopes } = review

  // Order matters: a grant can be both over-policy and write-bearing, and
  // "beyond policy" is the finding that needs acting on.
  if (excessScopes.length > 0) {
    return {
      variant: 'risk' as const,
      icon: <AlertTriangle className="mr-1 h-3 w-3" aria-hidden />,
      label: `${excessScopes.length} beyond policy`,
      detail: (
        <>
          <ScopeList label="Beyond what this integration may hold" scopes={excessScopes} />
          <ScopeList label="All granted" scopes={granted} />
        </>
      ),
    }
  }

  if (writeScopes.length > 0) {
    return {
      variant: 'warn' as const,
      icon: <PencilLine className="mr-1 h-3 w-3" aria-hidden />,
      label: `${writeScopes.length} write ${writeScopes.length === 1 ? 'scope' : 'scopes'}`,
      detail: (
        <>
          <ScopeList label="Can change data in this system" scopes={writeScopes} />
          <ScopeList label="All granted" scopes={granted} />
        </>
      ),
    }
  }

  return {
    variant: 'good' as const,
    icon: <ShieldCheck className="mr-1 h-3 w-3" aria-hidden />,
    label: 'Read-only',
    detail: <ScopeList label="Granted" scopes={granted} />,
  }
}

function ScopeList({ label, scopes }: { label: string; scopes: string[] }) {
  return (
    <div className="mb-1.5 last:mb-0">
      <p className="text-[11px] font-medium uppercase tracking-wide opacity-70">{label}</p>
      <ul className="mt-0.5 space-y-0.5">
        {scopes.slice(0, 12).map((scope) => (
          <li key={scope} className="font-mono text-[11px]">
            {scope}
          </li>
        ))}
        {scopes.length > 12 && (
          <li className="text-[11px] opacity-70">+{scopes.length - 12} more</li>
        )}
      </ul>
    </div>
  )
}
