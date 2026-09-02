'use client'

import { useEffect, useSyncExternalStore, type RefObject } from 'react'

/**
 * Whether a page-level assistant surface currently occupies the screen.
 *
 * Ask Backstory is mounted once by the app shell and pinned to the viewport's
 * bottom-right corner. Two page-level surfaces put their own composer in that
 * same corner — the agents Assistant and the flow builder's Copilot — and the
 * floating launcher sat on top of their text field.
 *
 * The shell and those pages are different React trees, so the signal cannot be
 * a prop. Each surface registers its root element while mounted and the shell
 * subscribes. Visibility is read from the element rather than assumed from the
 * mount, because /agents keeps its Assistant mounted and merely `display:none`s
 * it below the lg breakpoint — where there is no collision and the launcher
 * should stay.
 */

const surfaces = new Set<HTMLElement>()
const listeners = new Set<() => void>()
let visible = false

/** `offsetParent` is null when the element or an ancestor is display:none.
 *  getClientRects covers the position:fixed case, where offsetParent is null
 *  even when the element is on screen. */
function elementIsVisible(element: HTMLElement): boolean {
  return element.offsetParent !== null || element.getClientRects().length > 0
}

function recompute(): void {
  let next = false
  for (const element of surfaces) {
    if (elementIsVisible(element)) {
      next = true
      break
    }
  }
  if (next === visible) return
  visible = next
  for (const listener of listeners) listener()
}

/** Register a surface root. Returns the unregister function. */
export function registerAssistantSurface(element: HTMLElement): () => void {
  surfaces.add(element)
  recompute()
  return () => {
    surfaces.delete(element)
    recompute()
  }
}

export function isAssistantSurfaceVisible(): boolean {
  return visible
}

export function subscribeAssistantSurface(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Whether the shell should offer its floating launcher.
 *
 * It yields the corner to a page-level assistant, but only while it is closed:
 * a conversation the user is part-way through is never yanked out from under
 * them just because the page behind it has its own composer.
 */
export function shouldOfferLauncher(surfaceVisible: boolean, launcherOpen: boolean): boolean {
  return launcherOpen || !surfaceVisible
}

/**
 * Declare this component's root as an assistant surface for as long as it is
 * mounted. Re-checks on resize, since the agents Assistant appears and
 * disappears at the lg breakpoint without remounting.
 */
export function useAssistantSurface(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const unregister = registerAssistantSurface(element)
    const onResize = () => recompute()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      unregister()
    }
  }, [ref])
}

/** Read the signal. False during SSR — the shell must not omit the launcher
 *  from the server render and then flash it in. */
export function useAssistantSurfaceVisible(): boolean {
  return useSyncExternalStore(subscribeAssistantSurface, isAssistantSurfaceVisible, () => false)
}
