'use client'

import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { notifyAgentsChanged } from '@/components/layout/sidebar'
import { Camera, Check, Pencil, Play, Plus, Settings2, X } from 'lucide-react'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { AvatarPicker } from '@/components/agents/avatar-picker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/settings/dialogs'

import type { Agent, Teammate } from '@/lib/types'

/** Per-agent lifetime run counts, keyed by agent id. */
type Kpis = Record<string, { runs: number; completed: number; failed: number }>

/**
 * The drill-in for one avatar: who they are, and every job they run.
 *
 * A teammate has no single editor or run screen — that is the point of the
 * grouping — so this panel is where the card's two affordances land, and each
 * job on the list carries them individually.
 */
export function TeammatePanel({
  teammate,
  agents,
  kpis,
  roleLabel,
  onOpenAgent,
  onEditAgent,
  onClose,
  onChanged,
}: {
  teammate: Teammate
  agents: Agent[]
  kpis: Kpis
  roleLabel: string | null
  onOpenAgent: (id: string) => void
  onEditAgent: (id: string) => void
  onClose: () => void
  onChanged: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(teammate.name)
  const [saving, setSaving] = useState(false)
  const [confirmDisband, setConfirmDisband] = useState(false)
  const [pickingAvatar, setPickingAvatar] = useState(false)
  const [savingAvatar, setSavingAvatar] = useState(false)

  const chooseAvatar = async (avatarSeed: string | null) => {
    setSavingAvatar(true)
    try {
      const response = await fetch('/api/teammates', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: teammate.id, avatarSeed }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        toast.error(data.error || 'Could not change the avatar.')
        return
      }
      setPickingAvatar(false)
      // onChanged refreshes the gallery this panel sits in; the notify wakes
      // every OTHER surface showing this roster (sidebar, agents page) and
      // evicts the shared snapshot, so the new face appears everywhere without
      // a page refresh — the exact staleness this event exists to prevent.
      onChanged()
      notifyAgentsChanged()
    } finally {
      setSavingAvatar(false)
    }
  }

  const rename = async () => {
    const next = name.trim()
    if (!next || next === teammate.name) {
      setRenaming(false)
      setName(teammate.name)
      return
    }
    setSaving(true)
    try {
      const response = await fetch('/api/teammates', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: teammate.id, name: next }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        toast.error(data.error || 'Could not rename this teammate.')
        return
      }
      setRenaming(false)
      onChanged()
      notifyAgentsChanged()
    } finally {
      setSaving(false)
    }
  }

  const disband = async () => {
    const response = await fetch('/api/teammates', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: teammate.id }),
    })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      toast.error(data.error || 'Could not disband this teammate.')
      return
    }
    toast.success(`${teammate.name} disbanded. Their agents are back on the roster.`)
    onChanged()
    // Disbanding puts agents back on the roster — snapshot data the sidebar
    // shows, which otherwise stays stale until its 30s poll.
    notifyAgentsChanged()
    onClose()
  }

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <div className="flex items-start gap-3">
              <button
                type="button"
                onClick={() => setPickingAvatar(true)}
                aria-label={`Change ${teammate.name}'s avatar`}
                title="Change avatar"
                className="group relative shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
              >
                <AgentAvatar seed={teammate.avatarSeed || teammate.id} className="h-20 w-16 rounded-2xl ring-1 ring-black/5" />
                <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                  <Camera className="h-4 w-4 text-white" aria-hidden="true" />
                </span>
              </button>
              <div className="min-w-0 flex-1">
                {renaming ? (
                  <div className="flex items-center gap-1.5">
                    <Input
                      value={name}
                      autoFocus
                      maxLength={60}
                      disabled={saving}
                      onChange={(event) => setName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') rename()
                        if (event.key === 'Escape') { setRenaming(false); setName(teammate.name) }
                      }}
                      aria-label="Teammate name"
                      className="h-8"
                    />
                    <Button size="icon" variant="ghost" onClick={rename} disabled={saving} aria-label="Save name">
                      <Check className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => { setRenaming(false); setName(teammate.name) }}
                      aria-label="Cancel rename"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <DialogTitle className="truncate">{teammate.name}</DialogTitle>
                    <button
                      type="button"
                      onClick={() => setRenaming(true)}
                      aria-label={`Rename ${teammate.name}`}
                      className="rounded p-1 text-fg-muted transition-colors duration-150 hover:bg-gray-100 hover:text-gray-700"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
                <DialogDescription className="mt-1 flex flex-wrap items-center gap-2">
                  {roleLabel && (
                    <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-700">{roleLabel}</span>
                  )}
                  <span>{agents.length === 1 ? '1 job' : `${agents.length} jobs`}</span>
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="-mx-1 max-h-80 overflow-y-auto px-1">
            {agents.length === 0 ? (
              <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">
                No jobs yet. Install a template to give this teammate something to do.
              </p>
            ) : (
              <ul className="divide-y rounded-xl border">
                {agents.map((agent) => {
                  const kpi = kpis[agent.id]
                  const runs = kpi?.runs ?? agent.executionCount ?? 0
                  return (
                    <li key={agent.id} className="flex items-center gap-2 p-2.5">
                      <button
                        type="button"
                        onClick={() => onOpenAgent(agent.id)}
                        className="min-w-0 flex-1 rounded-lg px-1 text-left transition-colors duration-150 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
                      >
                        <span className="line-clamp-1 block text-sm font-medium text-foreground">{agent.title}</span>
                        <span className="block text-xs text-muted-foreground">
                          {agent.roleLabel ? `${agent.roleLabel} · ` : ''}
                          {runs === 1 ? '1 run' : `${runs.toLocaleString()} runs`}
                        </span>
                      </button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => onOpenAgent(agent.id)}
                        aria-label={`Open ${agent.title}`}
                        title="Open"
                      >
                        <Play className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => onEditAgent(agent.id)}
                        aria-label={`Configure ${agent.title}`}
                        title="Configure"
                      >
                        <Settings2 className="h-4 w-4" />
                      </Button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <Button variant="ghost" className="text-red-600 hover:bg-red-50 hover:text-red-700" onClick={() => setConfirmDisband(true)}>
              Disband
            </Button>
            <Button asChild variant="outline">
              <Link href="/templates">
                <Plus className="mr-1.5 h-4 w-4" /> Add a job
              </Link>
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {pickingAvatar && (
        <AvatarPicker
          baseSeed={teammate.id}
          current={teammate.avatarSeed}
          saving={savingAvatar}
          onCancel={() => setPickingAvatar(false)}
          onSelect={chooseAvatar}
        />
      )}
      <ConfirmDialog
        open={confirmDisband}
        onOpenChange={setConfirmDisband}
        title={`Disband ${teammate.name}?`}
        description="Their agents stay on the roster as their own cards. Nothing they've done is deleted."
        confirmLabel="Disband"
        destructive
        onConfirm={disband}
      />
    </>
  )
}
