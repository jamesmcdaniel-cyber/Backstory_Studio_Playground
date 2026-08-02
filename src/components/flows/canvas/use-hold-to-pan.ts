import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

const HOLD_MS = 250
const MOVE_TOLERANCE_PX = 5

export type HoldToPanOptions = {
  enabled: boolean
  /** Pan the viewport by a screen-pixel delta (React Flow's store `panBy`). */
  panBy: (delta: { x: number; y: number }) => void
  /** Called when the hold engages, before any panning — the canvas clears the
   *  pane's pending selection rect here so releasing doesn't read as a click. */
  onEngage?: () => void
  holdMs?: number
}

/**
 * Press-and-hold on empty canvas to pan. A quick left-drag still marquee-selects
 * (React Flow's own behavior); holding the button still for a beat converts the
 * gesture into a pan instead — the middle ground between "left-drag selects"
 * and switching to the hand tool.
 *
 * Works by listening in the capture phase on the wrapper ABOVE React Flow.
 * React Flow's pane records a zero-size selection rect on pointerdown but only
 * starts the marquee once the pointer moves past its click distance, so as long
 * as the pointer hasn't moved when the hold timer fires, the gesture is ours:
 * we stop further pointermoves from ever reaching the pane (React's synthetic
 * handlers live on the root above us, so capture-phase stopPropagation starves
 * them) and drive `panBy` from the deltas ourselves. The pointerup is let
 * through so the pane releases its pointer capture and store state; only the
 * click that follows is swallowed, so a hold-pan never deselects.
 */
export function useHoldToPan(ref: RefObject<HTMLElement | null>, options: HoldToPanOptions) {
  const [holdPanning, setHoldPanning] = useState(false)
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    const el = ref.current
    if (!el || !options.enabled) return

    let pending: { pointerId: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null
    let engaged: { pointerId: number; x: number; y: number } | null = null
    let suppressNextClick = false

    const cancelPending = () => {
      if (pending) clearTimeout(pending.timer)
      pending = null
    }

    const onPointerDown = (event: PointerEvent) => {
      suppressNextClick = false
      if (event.button !== 0 || !event.isPrimary) return
      // Only the empty pane itself — a press on a node, edge, or overlay keeps
      // its normal meaning.
      const target = event.target as HTMLElement | null
      if (!target?.classList.contains('react-flow__pane')) return
      cancelPending()
      const start = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
      pending = {
        ...start,
        timer: setTimeout(() => {
          pending = null
          engaged = start
          optionsRef.current.onEngage?.()
          setHoldPanning(true)
        }, optionsRef.current.holdMs ?? HOLD_MS),
      }
    }

    const onPointerMove = (event: PointerEvent) => {
      if (engaged && event.pointerId === engaged.pointerId) {
        event.stopPropagation()
        event.preventDefault()
        optionsRef.current.panBy({ x: event.clientX - engaged.x, y: event.clientY - engaged.y })
        engaged.x = event.clientX
        engaged.y = event.clientY
        return
      }
      if (pending && event.pointerId === pending.pointerId) {
        // Moved before the hold matured — it's a marquee; stand down.
        if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > MOVE_TOLERANCE_PX) cancelPending()
      }
    }

    const onPointerEnd = (event: PointerEvent) => {
      if (pending && event.pointerId === pending.pointerId) cancelPending()
      if (engaged && event.pointerId === engaged.pointerId) {
        engaged = null
        suppressNextClick = true
        setHoldPanning(false)
      }
    }

    const onClick = (event: MouseEvent) => {
      if (!suppressNextClick) return
      suppressNextClick = false
      event.stopPropagation()
      event.preventDefault()
    }

    el.addEventListener('pointerdown', onPointerDown, true)
    el.addEventListener('pointermove', onPointerMove, true)
    el.addEventListener('pointerup', onPointerEnd, true)
    el.addEventListener('pointercancel', onPointerEnd, true)
    el.addEventListener('click', onClick, true)
    return () => {
      cancelPending()
      setHoldPanning(false)
      el.removeEventListener('pointerdown', onPointerDown, true)
      el.removeEventListener('pointermove', onPointerMove, true)
      el.removeEventListener('pointerup', onPointerEnd, true)
      el.removeEventListener('pointercancel', onPointerEnd, true)
      el.removeEventListener('click', onClick, true)
    }
  }, [ref, options.enabled])

  return holdPanning
}
