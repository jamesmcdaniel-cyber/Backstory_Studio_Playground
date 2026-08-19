'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Check, ExternalLink, Plus, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

import type { Agent } from '@/lib/types'

type Skill = {
  id: string
  name: string
  description: string
  category: string
  tags?: string[]
}

/**
 * The skills library, scoped to one agent.
 *
 * Attaching a skill used to mean leaving the agent for /templates and coming
 * back, which is a long way around for "this agent should also know how to do
 * X". This is the same catalogue inline, with one-click attach against the open
 * agent; the full library (browsing, authoring, publishing) still lives in the
 * Library section.
 */
export function AgentSkillsPanel({ agent, onChanged }: { agent: Agent; onChanged: () => void }) {
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  // Mirrors the agent's attached set so a click reads as instant; the refetch
  // behind onChanged is what makes it durable.
  const [attached, setAttached] = useState<string[]>(agent.skills ?? [])

  useEffect(() => { setAttached(agent.skills ?? []) }, [agent.skills])

  useEffect(() => {
    fetch('/api/skills', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => { if (data?.skills) setSkills(data.skills) })
      .catch(() => undefined)
      .finally(() => setLoading(false))
  }, [])

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return skills
    return skills.filter((skill) =>
      [skill.name, skill.description, skill.category, ...(skill.tags ?? [])]
        .some((value) => value?.toLocaleLowerCase().includes(needle)))
  }, [skills, query])

  // Attached first, so what this agent already knows is never buried under the
  // catalogue.
  const ordered = useMemo(() => {
    const isAttached = (skill: Skill) => attached.includes(skill.id)
    return [...visible].sort((a, b) => Number(isAttached(b)) - Number(isAttached(a)))
  }, [visible, attached])

  const toggle = async (skill: Skill) => {
    const next = attached.includes(skill.id)
      ? attached.filter((id) => id !== skill.id)
      : [...attached, skill.id]
    const previous = attached
    setAttached(next)
    setBusyId(skill.id)
    try {
      const response = await fetch('/api/agents', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: agent.id, skills: next }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        setAttached(previous)
        toast.error(data.error || 'Could not update this agent’s skills.')
        return
      }
      onChanged()
    } catch {
      setAttached(previous)
      toast.error('Could not reach the server. Please try again.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" aria-hidden="true" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === 'Escape' && setQuery('')}
            placeholder="Search skills"
            aria-label="Search skills"
            className="pl-8"
          />
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/templates?asset=skills">
            Library <ExternalLink className="ml-1.5 h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        {attached.length === 0
          ? `${agent.title} has no skills yet.`
          : attached.length === 1
            ? `1 skill attached to ${agent.title}.`
            : `${attached.length} skills attached to ${agent.title}.`}
      </p>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-16 rounded-xl" />)}
        </div>
      ) : ordered.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          {query.trim() ? `No skill matches “${query.trim()}”.` : 'No skills in this workspace yet.'}
        </p>
      ) : (
        <ul className="space-y-2">
          {ordered.map((skill) => {
            const on = attached.includes(skill.id)
            return (
              <li
                key={skill.id}
                className={cn(
                  'flex items-start gap-3 rounded-xl border p-3 transition-colors duration-150',
                  on ? 'border-indigo-200 bg-indigo-50/50' : 'bg-white hover:bg-gray-50',
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <span className="line-clamp-1">{skill.name}</span>
                    {skill.category && (
                      <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600">{skill.category}</span>
                    )}
                  </p>
                  {skill.description && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{skill.description}</p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant={on ? 'outline' : 'default'}
                  disabled={busyId === skill.id}
                  onClick={() => toggle(skill)}
                  aria-label={on ? `Remove ${skill.name} from ${agent.title}` : `Add ${skill.name} to ${agent.title}`}
                  className="shrink-0"
                >
                  {on ? (
                    <><Check className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Added</>
                  ) : (
                    <><Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Add</>
                  )}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
