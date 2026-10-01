'use client'

import { usePathname } from 'next/navigation'

const CLASS_NAME = 'sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:border focus:border-graphite-200 focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-graphite-900 focus:shadow-3 focus:outline-none focus:ring-2 focus:ring-ring'

/** Keep the target on the current route when App Router swaps pages in place. */
export function SkipLink() {
  const pathname = usePathname()

  return (
    <a
      href={`${pathname}#main-content`}
      className={CLASS_NAME}
      onClick={(event) => {
        event.preventDefault()
        const main = document.getElementById('main-content')
        if (!main) return
        main.tabIndex = -1
        main.focus({ preventScroll: true })
        main.scrollIntoView({ block: 'start' })
        window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#main-content`)
      }}
    >
      Skip to main content
    </a>
  )
}
