'use client'

import { X } from 'lucide-react'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { Skeleton } from '@/components/ui/skeleton'
import type { WorkspaceConnections } from '@/components/integrations/integration-match'
import { cn } from '@/lib/utils'

/**
 * The chip picker for "which tools does this use".
 *
 * Shared by the template create/edit dialog and the template detail page's
 * tailoring panel, because those two surfaces must offer the SAME tools: a
 * template whose tool list can be edited in one place and not the other reads
 * as two different features.
 *
 * Three groups, in this order: the platform's attachable tools, this
 * workspace's custom MCP connections, and anything already selected that
 * matches neither. The third group is not decoration — a template written
 * against a tool this workspace never had (or that has since been removed)
 * would otherwise be un-deselectable, its requirement invisible and permanent.
 */
export function IntegrationPicker({
  available,
  selected,
  onToggle,
  labelledBy,
  showConnectionState = false,
}: {
  /** Null while the workspace's tool list is still loading. */
  available: WorkspaceConnections | null
  selected: string[]
  onToggle: (value: string) => void
  labelledBy?: string
  /**
   * Mark which tools this workspace has actually connected. On when the choice
   * is "does this fit my stack" (tailoring a template before installing it);
   * off when it is "what does this template call for" (authoring one), where a
   * not-yet-connected tool is a perfectly ordinary thing to require.
   */
  showConnectionState?: boolean
}) {
  if (!available) {
    return (
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-7 w-24 rounded-full" />
        <Skeleton className="h-7 w-20 rounded-full" />
        <Skeleton className="h-7 w-28 rounded-full" />
      </div>
    )
  }

  const chipClass = (isSelected: boolean) =>
    cn(
      'flex items-center gap-1.5 rounded-full border py-1 pl-1.5 pr-3 text-xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
      isSelected
        ? 'border-primary bg-primary text-primary-foreground'
        : 'border-border bg-transparent text-muted-foreground hover:border-primary hover:text-foreground',
    )

  return (
    <div role="group" aria-labelledby={labelledBy} className="flex flex-wrap gap-2">
      {available.tools.map((tool) => {
        const isSelected = selected.includes(tool.key)
        return (
          <button
            key={tool.key}
            type="button"
            onClick={() => onToggle(tool.key)}
            aria-pressed={isSelected}
            // The connected/not state has to reach the accessible name too: a
            // colored dot is invisible to a screen reader, and it is the whole
            // reason this picker is on the page.
            aria-label={showConnectionState ? `${tool.label} — ${tool.connected ? 'connected' : 'not connected'}` : undefined}
            className={chipClass(isSelected)}
          >
            <IntegrationLogo slug={tool.slug} name={tool.label} className="h-4 w-4 bg-white/70" />
            {tool.label}
            {showConnectionState && (
              <span
                aria-hidden="true"
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  tool.connected ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                )}
              />
            )}
          </button>
        )
      })}

      {available.connections.map((connection) => {
        const isSelected = selected.includes(connection.name)
        return (
          <button
            key={connection.id}
            type="button"
            onClick={() => onToggle(connection.name)}
            aria-pressed={isSelected}
            className={chipClass(isSelected)}
          >
            <IntegrationLogo
              slug={connection.name.toLowerCase().replace(/[^a-z0-9]+/g, '')}
              name={connection.name}
              className="h-4 w-4 bg-white/70"
            />
            {connection.name}
          </button>
        )
      })}

      {selectedButUnlisted(available, selected).map((name) => (
        <button
          key={name}
          type="button"
          onClick={() => onToggle(name)}
          aria-pressed
          className="flex items-center gap-1.5 rounded-full border border-primary bg-primary py-1 pl-3 pr-2 text-xs text-primary-foreground transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        >
          {name}
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      ))}
    </div>
  )
}

/** Selected tools this workspace cannot offer — kept visible so they can be removed. */
export function selectedButUnlisted(available: WorkspaceConnections, selected: string[]): string[] {
  return selected.filter(
    (name) =>
      !available.tools.some((tool) => tool.key === name) &&
      !available.connections.some((connection) => connection.name === name),
  )
}
