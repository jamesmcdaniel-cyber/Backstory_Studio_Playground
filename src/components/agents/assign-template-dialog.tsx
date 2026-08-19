'use client'

import { useEffect, useState } from 'react'
import { UserPlus } from 'lucide-react'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

import type { TemplateDestination } from '@/lib/client/agent-from-template'
import type { Teammate } from '@/lib/types'

/**
 * Picks who does the job a template describes.
 *
 * A template is work, not a person, so installing one asks which avatar takes
 * it on: an existing teammate gains another job, or a new teammate is hired for
 * it. The dialog only chooses a destination — the caller does the installing.
 */
export function AssignTemplateDialog({
  templateName,
  busy,
  onCancel,
  onConfirm,
}: {
  templateName: string
  busy: boolean
  onCancel: () => void
  onConfirm: (destination: TemplateDestination) => void
}) {
  const [teammates, setTeammates] = useState<Teammate[]>([])
  const [loading, setLoading] = useState(true)
  // Either an existing teammate's id, or the sentinel for hiring a new one.
  const [choice, setChoice] = useState<string>('new')
  const [newName, setNewName] = useState(templateName)

  useEffect(() => {
    fetch('/api/teammates', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        const list: Teammate[] = data?.teammates ?? []
        setTeammates(list)
        // Default to the first existing teammate when there is one: adding to
        // the roster you already have is the common case once it exists.
        if (list.length) setChoice(list[0].id)
      })
      .catch(() => undefined)
      .finally(() => setLoading(false))
  }, [])

  const confirm = () => {
    if (choice === 'new') {
      const name = newName.trim()
      if (!name) return
      onConfirm({ newTeammateName: name })
      return
    }
    onConfirm({ teammateId: choice })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Who takes this on?</DialogTitle>
          <DialogDescription>
            “{templateName}” becomes a job on someone’s roster. One teammate can run several.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-72 space-y-1.5 overflow-y-auto">
          {loading ? (
            <p className="p-3 text-sm text-muted-foreground">Loading your roster…</p>
          ) : (
            teammates.map((teammate) => (
              <button
                key={teammate.id}
                type="button"
                onClick={() => setChoice(teammate.id)}
                aria-pressed={choice === teammate.id}
                className={cn(
                  'flex w-full items-center gap-3 rounded-xl border p-2.5 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300',
                  choice === teammate.id ? 'border-indigo-300 bg-indigo-50/60' : 'hover:bg-gray-50',
                )}
              >
                <AgentAvatar seed={teammate.id} className="h-10 w-10 shrink-0 rounded-full ring-1 ring-black/5" />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-1 block text-sm font-medium text-foreground">{teammate.name}</span>
                  {teammate.roleLabel && (
                    <span className="block text-xs text-muted-foreground">{teammate.roleLabel}</span>
                  )}
                </span>
              </button>
            ))
          )}

          <button
            type="button"
            onClick={() => setChoice('new')}
            aria-pressed={choice === 'new'}
            className={cn(
              'flex w-full items-center gap-3 rounded-xl border border-dashed p-2.5 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300',
              choice === 'new' ? 'border-indigo-300 bg-indigo-50/60' : 'hover:bg-gray-50',
            )}
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-500">
              <UserPlus className="h-4 w-4" aria-hidden="true" />
            </span>
            <span className="text-sm font-medium text-foreground">Hire a new teammate</span>
          </button>

          {choice === 'new' && (
            <div className="px-1 pt-1">
              <label htmlFor="new-teammate-name" className="mb-1 block text-xs font-medium text-muted-foreground">
                Teammate name
              </label>
              <Input
                id="new-teammate-name"
                value={newName}
                maxLength={60}
                autoFocus
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && confirm()}
                placeholder="e.g. Dana"
              />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={confirm} loading={busy} disabled={choice === 'new' && !newName.trim()}>
            Add job
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
