'use client'

import { useCallback, useMemo, useState } from 'react'
import { Maximize2, Search, ZoomIn, ZoomOut } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Floating zoom / fit / search rail anchored to the canvas scroll container. */
export function CanvasRail({
  zoom,
  onZoom,
  onFit,
  nodes,
  onJump,
}: {
  zoom: number
  onZoom: (zoom: number) => void
  onFit: () => void
  nodes: { id: string; title: string }[]
  onJump: (id: string) => void
}) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return nodes
    return nodes.filter((node) => node.title.toLowerCase().includes(q))
  }, [nodes, query])

  const stop = (event: React.MouseEvent) => event.stopPropagation()
  const focusOnMount = useCallback((element: HTMLInputElement | null) => element?.focus(), [])

  return (
    <div
      role="presentation"
      className="absolute bottom-6 left-4 z-10 flex flex-col items-stretch overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.12)]"
      onClick={stop}
    >
      <button
        type="button"
        onClick={(event) => {
          stop(event)
          onZoom(zoom + 0.1)
        }}
        aria-label="Zoom in"
        title="Zoom in"
        className="flex h-9 w-9 items-center justify-center text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-900"
      >
        <ZoomIn className="h-4 w-4" />
      </button>
      <div className="w-full border-t border-slate-200 py-1 text-center text-[10px] font-semibold text-slate-500">
        {Math.round(zoom * 100)}%
      </div>
      <button
        type="button"
        onClick={(event) => {
          stop(event)
          onZoom(zoom - 0.1)
        }}
        aria-label="Zoom out"
        title="Zoom out"
        className="flex h-9 w-9 items-center justify-center border-t border-slate-200 text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-900"
      >
        <ZoomOut className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={(event) => {
          stop(event)
          onFit()
        }}
        aria-label="Fit view"
        title="Fit view"
        className="flex h-9 w-9 items-center justify-center border-t border-slate-200 text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-900"
      >
        <Maximize2 className="h-4 w-4" />
      </button>
      <div className="relative">
        <button
          type="button"
          onClick={(event) => {
            stop(event)
            setSearchOpen((open) => !open)
          }}
          aria-label="Search steps"
          title="Search steps"
          className={cn(
            'flex h-9 w-9 items-center justify-center border-t border-slate-200 text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-900',
            searchOpen && 'bg-slate-50 text-slate-900',
          )}
        >
          <Search className="h-4 w-4" />
        </button>
        {searchOpen && (
          <div
            role="presentation"
            className="absolute bottom-0 left-full ml-2 w-64 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.12)]"
            onClick={stop}
          >
            <input
              ref={focusOnMount}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search steps..."
              className="w-full border-b border-slate-200 px-3 py-2 text-sm text-slate-950 outline-none placeholder:text-slate-400 focus:border-blue-500"
            />
            <div className="max-h-56 overflow-y-auto py-1">
              {results.length === 0 && <p className="px-3 py-2 text-xs text-slate-400">No matching steps.</p>}
              {results.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  onClick={(event) => {
                    stop(event)
                    onJump(node.id)
                    setSearchOpen(false)
                    setQuery('')
                  }}
                  className="block w-full truncate px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                >
                  {node.title}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
