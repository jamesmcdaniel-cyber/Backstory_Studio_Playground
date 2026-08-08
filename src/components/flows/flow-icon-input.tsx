'use client'

import { Workflow } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Suggested emoji for flow cards — pipeline-flavored, one tap to pick. */
const SUGGESTED_ICONS = ['📊', '📈', '✉️', '🔔', '📝', '🗓️', '🔍', '⚡', '🤖', '💼', '🚀', '✅']

/**
 * Emoji picker for a flow's card icon: a "default" tile (the generic Workflow
 * glyph), a row of suggestions, and a free field for any other emoji. '' means
 * the default glyph — same convention as templates.
 */
export function FlowIconInput({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const tile = (selected: boolean) =>
    cn(
      'flex h-9 w-9 items-center justify-center rounded-lg border text-base transition-colors',
      selected
        ? 'border-indigo-300 bg-indigo-50 dark:border-indigo-500/40 dark:bg-indigo-500/10'
        : 'border-border hover:bg-muted',
    )
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => onChange('')} className={tile(value === '')} title="Default icon" aria-label="Default icon">
          <Workflow className="h-[18px] w-[18px] text-muted-foreground" />
        </button>
        {SUGGESTED_ICONS.map((emoji) => (
          <button key={emoji} type="button" onClick={() => onChange(emoji)} className={tile(value === emoji)} aria-label={`Use ${emoji} as the icon`}>
            <span aria-hidden>{emoji}</span>
          </button>
        ))}
      </div>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value.trim().slice(0, 16))}
        className="w-40 rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        placeholder="Or paste any emoji"
        aria-label="Custom icon emoji"
      />
    </div>
  )
}
