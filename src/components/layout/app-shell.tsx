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

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? ''
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
      <div className="flex h-screen overflow-hidden bg-background">
        <Sidebar />
        <main id="main-content" className="app-canvas relative flex-1 overflow-y-auto">
          {fullscreen ? (
            // INNER boundary resets on navigation so a page error clears when the
            // user clicks away, instead of leaving them stuck on the fallback.
            <motion.div key={pathname} className="relative h-full" {...routeMotion}>
              <ErrorBoundary resetKey={pathname}><SetupGate>{children}</SetupGate></ErrorBoundary>
            </motion.div>
          ) : (
            <motion.div
              key={pathname}
              className="container relative mx-auto max-w-7xl px-3 py-4 sm:px-6 sm:py-8"
              {...routeMotion}
            >
              <ErrorBoundary resetKey={pathname}><SetupGate>{children}</SetupGate></ErrorBoundary>
            </motion.div>
          )}
        </main>
      </div>
    </ErrorBoundary>
  )
}
