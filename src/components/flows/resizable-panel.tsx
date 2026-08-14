'use client'

import { useCallback, useRef, useState, type ReactNode } from 'react'

/**
 * A right-docked panel the user can widen/narrow by dragging its left edge.
 * Width persists per `storageKey`. Used for the flow builder's config drawer,
 * copilot, and runs panels.
 */
export function ResizablePanel({
  children,
  storageKey,
  defaultWidth = 320,
  min = 280,
  max = 760,
}: {
  children: ReactNode
  storageKey: string
  defaultWidth?: number
  min?: number
  max?: number
}) {
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return defaultWidth
    const saved = Number(window.localStorage.getItem(storageKey))
    return saved ? Math.min(max, Math.max(min, saved)) : defaultWidth
  })
  const widthRef = useRef(width)

  const onMouseDown = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      const startX = event.clientX
      const startWidth = widthRef.current
      const onMove = (moveEvent: MouseEvent) => {
        // Panel is on the right, so dragging LEFT (smaller clientX) widens it.
        const next = Math.min(max, Math.max(min, startWidth + (startX - moveEvent.clientX)))
        widthRef.current = next
        setWidth(next)
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
        try {
          window.localStorage.setItem(storageKey, String(widthRef.current))
        } catch {
          /* storage unavailable */
        }
      }
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [min, max, storageKey],
  )

  return (
    <div className="relative shrink-0 animate-slide-in-right" style={{ width }}>
      <div
        role="slider"
        aria-orientation="vertical"
        aria-label="Resize panel"
        aria-valuenow={width}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        onMouseDown={onMouseDown}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          // Panel is on the right, so moving the separator LEFT widens it.
          const next = Math.min(max, Math.max(min, widthRef.current + (event.key === 'ArrowLeft' ? 16 : -16)))
          widthRef.current = next
          setWidth(next)
          try {
            window.localStorage.setItem(storageKey, String(next))
          } catch {
            /* storage unavailable */
          }
        }}
        onDoubleClick={() => {
          widthRef.current = defaultWidth
          setWidth(defaultWidth)
        }}
        title="Drag to resize · double-click to reset"
        className="absolute left-0 top-0 z-20 h-full w-1.5 -translate-x-1/2 cursor-col-resize transition-colors hover:bg-indigo-300/60"
      />
      {children}
    </div>
  )
}
