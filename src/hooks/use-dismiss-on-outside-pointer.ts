'use client'

import { useEffect, useRef, type RefObject } from 'react'

/**
 * Close a popover when the pointer goes down outside it, or on Escape.
 *
 * Deliberately NOT the usual `fixed inset-0` backdrop element. Several of this
 * app's popovers live inside containers that carry backdrop-filter or transform
 * — the sidebar (backdrop-blur + translate), the zoomed flow canvas (scale),
 * the step drawer's blurred overlay — and either property makes that container
 * the CONTAINING BLOCK for its position:fixed descendants. A backdrop rendered
 * inside one therefore covers only that container, never the viewport, which
 * fails in both directions at once: clicks outside the container don't close
 * the popover, while clicks inside it (sidebar nav links, canvas nodes) hit the
 * invisible backdrop instead of their target. On the zoomed canvas the backdrop
 * is scaled too, so it doesn't even line up with what it appears to cover.
 *
 * A capture-phase document listener has neither failure mode and swallows no
 * clicks: the dismissal and the click that caused it both land.
 *
 * Pass a ref for every element that should count as "inside" — typically the
 * panel and the trigger that toggles it (so the trigger's own click can close
 * the popover itself rather than being treated as an outside dismissal).
 */
export function useDismissOnOutsidePointer(
  open: boolean,
  onDismiss: () => void,
  refs: Array<RefObject<HTMLElement | null>>,
) {
  // Held in refs so a new array literal or inline callback each render doesn't
  // detach and reattach the listeners.
  const refsRef = useRef(refs)
  const dismissRef = useRef(onDismiss)
  refsRef.current = refs
  dismissRef.current = onDismiss

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (refsRef.current.some((ref) => ref.current?.contains(target))) return
      dismissRef.current()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismissRef.current()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])
}
