'use client'

import { Check, Globe, Server } from 'lucide-react'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { classifyRequirement, integrationLabel, integrationSlug } from '@/components/integrations/integration-match'
import { cn } from '@/lib/utils'

/**
 * A labelled pill with the integration's brand logo. Names arrive as free text
 * from templates ("nango:salesforce", "Backstory MCP", "HTTP API"); the label
 * and mark both come from integration-match so a chip never leaks an internal
 * plane prefix and never renders a blank square.
 *
 * Pass `onClick` to make the chip actionable — the template pages use that to
 * open the connect dialog on the integration the user pointed at.
 */

// Re-exported: these used to live here, and both names are part of the module's
// public surface (chips, banners and tests import them from either path).
export { integrationLabel, integrationSlug }

/** The mark for a requirement: brand logo, globe for HTTP, server for MCP. */
export function IntegrationMark({ name, className }: { name: string; className?: string }) {
  const { label, kind } = classifyRequirement(name)
  const box = cn('h-4 w-4 shrink-0', className)
  if (kind === 'builtin') return <Globe className={cn(box, 'text-muted-foreground')} aria-hidden />
  const slug = integrationSlug(label) ?? integrationSlug(name)
  if (kind === 'mcp' && !slug) return <Server className={cn(box, 'text-muted-foreground')} aria-hidden />
  return <IntegrationLogo name={label} slug={slug} className={box} />
}

export function IntegrationChip({
  name,
  onClick,
  connected,
  className,
}: {
  name: string
  /** Makes the chip a button — e.g. "connect this one" from a template page. */
  onClick?: () => void
  /** Shows a subtle connected tick when known. Omit when status isn't loaded. */
  connected?: boolean
  className?: string
}) {
  const label = integrationLabel(name)
  const body = (
    <>
      <IntegrationMark name={name} />
      {label}
      {connected && <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" aria-label="Connected" />}
    </>
  )
  const shell = cn(
    'inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 py-1 pl-1 pr-2.5 text-xs font-medium text-foreground/80',
    className,
  )

  if (!onClick) return <span className={shell}>{body}</span>
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(shell, 'transition-colors hover:border-border hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1')}
      title={connected ? `${label} is connected` : `Connect ${label}`}
    >
      {body}
    </button>
  )
}
