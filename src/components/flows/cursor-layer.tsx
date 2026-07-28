'use client'

import type { RemoteCursor } from '@/lib/flows/cursor-store'

/**
 * Remote collaborators' pointers. Rendered INSIDE the transformed content layer
 * of whichever builder view is active, so the shared coordinates inherit the
 * same pan/zoom the nodes get — a cursor parked on a step shows on that step
 * for every viewer. Positions animate via a short transform transition (the
 * stream is throttled to ~25/s, so CSS interpolates between packets). Idle
 * cursors are pruned by the collab hook; pointer events pass through.
 *
 * `anchor` picks how the layer is placed: `fill` stretches over the Inline
 * canvas's content element, `origin` pins a zero-size layer at the flow origin
 * for React Flow's ViewportPortal, where stretching would distort the frame.
 */
export function CursorLayer({ cursors, anchor = 'fill' }: { cursors: RemoteCursor[]; anchor?: 'fill' | 'origin' }) {
  if (cursors.length === 0) return null
  return (
    <div
      aria-hidden
      className={anchor === 'origin' ? 'pointer-events-none absolute left-0 top-0 z-20' : 'pointer-events-none absolute inset-0 z-20'}
    >
      {cursors.map((c) => (
        <div
          key={c.clientId}
          className="absolute left-0 top-0 transition-transform duration-100 ease-linear will-change-transform"
          style={{ transform: `translate(${c.x}px, ${c.y}px)` }}
        >
          <svg width="16" height="20" viewBox="0 0 16 20" className="drop-shadow-sm">
            <path d="M1 1l5.5 16 2.4-6.8L15 8.5z" fill={c.color} stroke="white" strokeWidth="1.2" />
          </svg>
          <span
            className="ml-3 inline-block max-w-[140px] -translate-y-1 truncate rounded-full px-2 py-0.5 text-[10px] font-semibold text-white shadow-sm"
            style={{ backgroundColor: c.color }}
          >
            {c.name}
          </span>
        </div>
      ))}
    </div>
  )
}
