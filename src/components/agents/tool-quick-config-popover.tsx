'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, SlidersHorizontal } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { useDismissOnOutsidePointer } from '@/hooks/use-dismiss-on-outside-pointer'
import { cn } from '@/lib/utils'
import { scopeSummary, type ToolQuickConfig, type ToolScopeOption } from '@/lib/connectors/tool-quick-config'

/**
 * A connected-tools chip with per-tool quick configuration — the gear opens a
 * popover that fetches the LIVE resources of the connected account (Slack
 * channels, GitHub repos…) through the same read-only /api/flows/tool-options
 * endpoint the flow builder's resource picker uses, and lets the user restrict
 * the agent to a subset. Empty selection = the whole account (the same "empty
 * = all" sentinel the subagent and flow pickers use).
 */
export function QuickConfigChip({
  label,
  slug,
  connected,
  selected,
  config,
  value,
  onToggle,
  onValueChange,
}: {
  label: string
  slug: string
  connected: boolean
  selected: boolean
  config: ToolQuickConfig
  value: ToolScopeOption[]
  onToggle: () => void
  onValueChange: (value: ToolScopeOption[]) => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  useDismissOnOutsidePointer(open, () => setOpen(false), [wrapRef])

  return (
    <div className="relative" ref={wrapRef}>
      <div
        className={cn(
          'flex items-center rounded-full border text-xs transition-colors duration-150',
          selected
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-border bg-transparent text-muted-foreground hover:border-primary hover:text-foreground',
        )}
      >
        <button type="button" onClick={onToggle} className="flex items-center gap-1.5 py-1 pl-1.5 pr-2">
          <IntegrationLogo slug={slug} name={label} className="h-4 w-4 bg-white/70" />
          {label}
          {!connected && !selected && <span className="text-[10px] opacity-60">not configured</span>}
          {connected && !selected && <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500" />}
        </button>
        {/*
          Openable while the chip is UNATTACHED too.
          Deciding whether to attach a server is a question about what it can
          do, and gating the tool list behind attaching meant the only way to
          find out was to commit first — an MCP connection sat there as a name
          and a green dot, identical whether it exposed thirty tools or none.
          The list is fetched when the popover opens, so an unattached chip
          costs nothing until someone asks.
        */}
        {(selected || connected) && (
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            title={selected ? `Choose ${config.nounPlural}` : `See this connection’s ${config.nounPlural}`}
            className={cn(
              'flex items-center gap-1 rounded-r-full border-l py-1 pl-2 pr-2.5 transition-colors',
              selected
                ? 'border-primary-foreground/25 hover:bg-primary-foreground/10'
                : 'border-border hover:bg-muted',
            )}
          >
            <SlidersHorizontal className="h-3 w-3" />
            <span className="text-[10px] capitalize">
              {/* An unattached chip must not read "All tools" — that is a
                  statement about a scope the agent does not have. */}
              {selected ? scopeSummary(config, value) : config.nounPlural}
            </span>
          </button>
        )}
      </div>
      {open && (
        <QuickConfigPanel
          config={config}
          value={value}
          onValueChange={(next) => {
            // Choosing tools on a chip that is not attached says plainly that
            // you want this connection — restricting an agent to a subset of a
            // server it cannot use is not a state worth being able to reach.
            if (!selected && next.length > 0) onToggle()
            onValueChange(next)
          }}
        />
      )}
    </div>
  )
}

function QuickConfigPanel({
  config,
  value,
  onValueChange,
}: {
  config: ToolQuickConfig
  value: ToolScopeOption[]
  onValueChange: (value: ToolScopeOption[]) => void
}) {
  const [liveOptions, setLiveOptions] = useState<ToolScopeOption[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [loadKey, setLoadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setError(null)
    setLiveOptions(null)
    // Two option sources: a read-only tool run (resource scopes: channels,
    // repos) or a plain GET (an MCP server's own tool list).
    const load = config.optionsUrl
      ? fetch(config.optionsUrl, { cache: 'no-store' })
      : fetch('/api/flows/tool-options', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config.optionsRequest),
        })
    load
      .then(async (response) => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok || !data.success) throw new Error(data.error || `Could not load ${config.nounPlural}.`)
        return (Array.isArray(data.items) ? data.items : []).map(config.mapItem).filter((o: ToolScopeOption | null): o is ToolScopeOption => Boolean(o))
      })
      .then((options) => { if (!cancelled) setLiveOptions(options) })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : `Could not load ${config.nounPlural}.`)
      })
    return () => { cancelled = true }
  }, [config, loadKey])

  // Keep already-chosen options visible even when the live list no longer
  // returns them (archived channel, lost repo access) so they can be unchecked.
  const options = useMemo(() => {
    const live = liveOptions ?? []
    const liveIds = new Set(live.map((option) => option.id))
    return [...value.filter((option) => !liveIds.has(option.id)), ...live]
  }, [liveOptions, value])

  const query = search.trim().toLowerCase()
  const visible = query
    ? options.filter((option) => option.label.toLowerCase().includes(query) || option.id.toLowerCase().includes(query))
    : options

  const selectedIds = new Set(value.map((option) => option.id))
  const allSelected = value.length === 0
  const toggleOption = (option: ToolScopeOption) => {
    if (allSelected) return onValueChange([option])
    if (selectedIds.has(option.id)) return onValueChange(value.filter((v) => v.id !== option.id))
    onValueChange([...value, option])
  }

  return (
    <div className="absolute left-0 top-full z-30 mt-2 w-72 origin-top animate-scale-in rounded-lg border border-border bg-card p-3 text-left shadow-popover">
      <p className="text-xs font-medium text-foreground">{config.title}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{config.description}</p>

      {error ? (
        <div className="mt-3 rounded-md border border-dashed p-2 text-xs text-muted-foreground">
          {error}
          <button
            type="button"
            onClick={() => setLoadKey((k) => k + 1)}
            className="ml-2 font-medium text-primary hover:underline"
          >
            Retry
          </button>
        </div>
      ) : liveOptions === null ? (
        <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading {config.nounPlural}…
        </p>
      ) : (
        <>
          {options.length > 7 && (
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={`Search ${config.nounPlural}…`}
              className="mt-2 h-7 text-xs"
            />
          )}
          <label className="mt-2 flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-indigo-600"
              checked={allSelected}
              onChange={() => onValueChange([])}
            />
            <span className="font-medium">All {config.nounPlural}</span>
            <span className="text-xs text-muted-foreground">({options.length} available)</span>
          </label>
          {visible.length > 0 ? (
            <div className="mt-1 max-h-48 space-y-0.5 overflow-y-auto rounded-md border p-1">
              {visible.map((option) => (
                <label
                  key={option.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted"
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-indigo-600"
                    checked={allSelected || selectedIds.has(option.id)}
                    onChange={() => toggleOption(option)}
                  />
                  <span className="truncate">{option.label}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="mt-2 px-1 text-xs text-muted-foreground">
              {query ? `No ${config.nounPlural} match “${search.trim()}”.` : `No ${config.nounPlural} found on the connected account.`}
            </p>
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">{scopeSummary(config, value)} allowed for this agent.</p>
        </>
      )}
    </div>
  )
}
