'use client'

import Link from 'next/link'
import { Workflow, Pencil, Trash2, Layers } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { IntegrationChip } from '@/components/integrations/integration-chip'
import { cn } from '@/lib/utils'

/** The list shape the Flows tab renders — a trimmed SerializedFlowTemplate. */
export interface FlowTemplateItem {
  id: string
  name: string
  description: string
  category: string
  icon?: string
  integrations?: string[]
  tags?: string[]
  stepCount: number
  setupCount: number
  custom?: boolean
  mine?: boolean
  source?: string
}

/**
 * A flow-template card. Deliberately different from the agent-template card in
 * the two ways that matter to someone choosing one: it leads with how many
 * steps the pipeline has, and it says up front how much setup it needs — the
 * question "can I use this right now?" answered before the click.
 */
export function FlowTemplateCard({
  template,
  accent,
  onEdit,
  onDelete,
  onUse,
  usePending = false,
  useDisabled = false,
}: {
  template: FlowTemplateItem
  accent: { bar: string; tile: string; badge: string; ring: string }
  onEdit?: (template: FlowTemplateItem) => void
  onDelete?: (template: FlowTemplateItem) => void
  /** When set, the card gets a real "Use this template" button that instantiates in place (the card itself still opens the detail page). */
  onUse?: (template: FlowTemplateItem) => void
  usePending?: boolean
  useDisabled?: boolean
}) {
  const readyNow = template.setupCount === 0
  return (
    <Link href={`/flow-templates/${template.id}`} className="block">
      <Card
        className={cn(
          'group relative h-full overflow-hidden border-border/60 transition-[transform,box-shadow,border-color] duration-300 ease-out-quart',
          'hover:-translate-y-1 hover:shadow-4 hover:ring-1',
          accent.ring,
        )}
      >
        <div className={cn('absolute inset-x-0 top-0 z-10 h-1 bg-gradient-to-r opacity-80 transition-opacity group-hover:opacity-100', accent.bar)} />
        {template.mine && (onEdit || onDelete) && (
          <div className="absolute right-2 top-2 z-10 hidden gap-1 group-hover:flex">
            {onEdit && (
              <button
                type="button"
                aria-label="Edit flow template"
                onClick={(e) => { e.preventDefault(); onEdit(template) }}
                className="rounded-md border bg-card p-1.5 text-muted-foreground shadow-1 hover:text-indigo-600"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                aria-label="Delete flow template"
                onClick={(e) => { e.preventDefault(); onDelete(template) }}
                className="rounded-md border bg-card p-1.5 text-muted-foreground shadow-1 hover:text-red-600"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}

        <CardHeader className="space-y-2.5 pt-5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className={cn('text-[11px] font-medium', accent.badge)}>{template.category}</Badge>
            {template.custom && (
              <Badge variant="outline" className="border-indigo-200 bg-indigo-50 text-[11px] font-medium text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300">
                Community
              </Badge>
            )}
            {template.source === 'ai_generated' && (
              <Badge variant="outline" className="border-violet-200 bg-violet-50 text-[11px] font-medium text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300">
                Suggested for you
              </Badge>
            )}
          </div>
          <div className="flex items-start gap-2.5">
            <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-base transition-transform group-hover:scale-105', accent.tile)}>
              {template.icon ? <span aria-hidden>{template.icon}</span> : <Workflow className="h-[18px] w-[18px]" />}
            </span>
            <CardTitle className="min-w-0 text-base leading-snug">{template.name}</CardTitle>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Layers className="h-3.5 w-3.5" />
              {template.stepCount} {template.stepCount === 1 ? 'step' : 'steps'}
            </span>
            <span className={cn('font-medium', readyNow ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400')}>
              {readyNow ? 'Ready to run' : `${template.setupCount} to set up`}
            </span>
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          <p className="line-clamp-3 text-sm text-muted-foreground">{template.description}</p>
          {template.integrations && template.integrations.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Requires</p>
              <div className="flex flex-wrap gap-1.5">
                {template.integrations.map((name) => (
                  <IntegrationChip key={name} name={name} />
                ))}
              </div>
            </div>
          )}
          {onUse ? (
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              disabled={useDisabled}
              loading={usePending}
              onClick={(event) => { event.preventDefault(); event.stopPropagation(); onUse(template) }}
            >
              Use this template
            </Button>
          ) : (
            <div className="flex items-center gap-1 pt-1 text-sm font-medium text-indigo-600 opacity-0 transition-opacity group-hover:opacity-100 dark:text-indigo-300">
              Use this flow
              <span aria-hidden className="transition-transform group-hover:translate-x-0.5">→</span>
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
  )
}
