'use client'

import { ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { motion, useReducedMotion } from 'motion/react'
import { Sidebar } from './sidebar'
import { SetupGate } from './setup-gate'
import { ErrorBoundary } from '@/components/ui/error-boundary'

/**
 * The single app chrome, mounted once in the root layout so the sidebar
 * PERSISTS across client navigations instead of remounting per page (each
 * authenticated page used to render its own <DashboardLayout>, so navigating
 * between them tore down and rebuilt the sidebar every time).
 *
 * On authenticated routes it renders the sidebar + content region; on public
 * routes (marketing, auth, connect) it passes children through untouched. The
 * <main id="main-content"> wrapper (skip-link target) is preserved in both.
 */

// Route prefixes that get the app chrome. Everything else (/, /auth/*, /connect,
// /privacy, /terms, /auth-code-error) renders bare.
const APP_PREFIXES = ['/dashboard', '/agents', '/integrations', '/connections', '/templates', '/flows', '/approvals', '/settings']

// Only the agent HQ (/agents) + the flow builder want an edge-to-edge
// (fullscreen) content area; the rest — incl. the Librarian assistant home
// (/dashboard) and the /flows list — use the centered container.
const FULLSCREEN_ROUTES = new Set(['/agents'])

/**
 * THE app content measure — the single place the width, centering and gutters
 * of a contained page are defined. Pages must NOT add their own
 * `mx-auto max-w-*`: when each route picked its own measure (7xl here, 6xl
 * there, 5xl on approvals) the content's left/right edges jumped on every
 * navigation. A page that needs a narrower reading column narrows an inner
 * block, never this wrapper.
 *
 * Deliberately not Tailwind's `.container`: its per-breakpoint max-widths fight
 * whatever `max-w-*` sits next to it, which is how the widths drifted apart.
 */
export const PAGE_CONTAINER = 'mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8'

/** Trailing slashes must not decide which layout a route gets. */
function normalizePath(input: string) {
  const trimmed = input.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

export function AppShell({ children }: { children: ReactNode }) {
  const rawPathname = usePathname() ?? ''
  const pathname = normalizePath(rawPathname)
  const reduceMotion = useReducedMotion()
  const isAppRoute = APP_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))

  if (!isAppRoute) {
    // Public routes (incl. /connect onboarding) still get a boundary so a render
    // throw shows the fallback card, not a white screen.
    return (
      <ErrorBoundary resetKey={pathname}>
        <main id="main-content">{children}</main>
      </ErrorBoundary>
    )
  }

  // The flow builder (/flows/<id>) is fullscreen; the /flows list AND any
  // deeper /flows/<id>/* subpage (e.g. /flows/<id>/activity) use the centered
  // container, so only exactly one path segment past "/flows/" goes edge-to-edge.
  const flowSegments = pathname.startsWith('/flows/') ? pathname.slice('/flows/'.length).split('/').filter(Boolean) : []
  const fullscreen = FULLSCREEN_ROUTES.has(pathname) || flowSegments.length === 1
  const routeMotion = reduceMotion
    ? {}
    : {
        initial: { opacity: 0, y: 7 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.28, ease: [0.25, 1, 0.5, 1] as const },
      }

  return (
    // OUTER boundary wraps the whole shell (incl. the Sidebar) so a sidebar
    // render throw no longer white-screens the entire authenticated app. It is
    // NOT keyed on pathname so the persistent sidebar isn't remounted per nav.
    <ErrorBoundary>
      {/*
        The shell owns the viewport: h-dvh (not h-screen/100vh, which on mobile
        browsers is TALLER than the visible area and pushes the sidebar's footer
        below the fold behind a page-level scrollbar). Pages size themselves off
        this region with h-full and never restate a viewport height.
        min-w-0 on <main> keeps a wide child (canvas, table) from stretching the
        flex row past the viewport and scrolling the sidebar off-screen.
      */}
      <div className="flex h-dvh overflow-hidden bg-background">
        <Sidebar />
        <main
          id="main-content"
          className={`app-canvas relative min-h-0 min-w-0 flex-1 ${
            fullscreen ? 'overflow-hidden' : 'overflow-y-auto'
          }`}
        >
          {fullscreen ? (
            // INNER boundary resets on navigation so a page error clears when the
            // user clicks away, instead of leaving them stuck on the fallback.
            // Pin fullscreen routes to the shell's actual content box. Using an
            // absolute inset here avoids a descendant's content height ever
            // enlarging <main> and creating a second, page-level scrollbar.
            <motion.div
              key={pathname}
              className="absolute inset-0 min-h-0 w-full overflow-hidden"
              {...routeMotion}
            >
              <ErrorBoundary resetKey={pathname}><SetupGate>{children}</SetupGate></ErrorBoundary>
            </motion.div>
          ) : (
            <motion.div key={pathname} className={`relative ${PAGE_CONTAINER}`} {...routeMotion}>
              <ErrorBoundary resetKey={pathname}><SetupGate>{children}</SetupGate></ErrorBoundary>
            </motion.div>
          )}
        </main>
      </div>
    </ErrorBoundary>
  )
}
