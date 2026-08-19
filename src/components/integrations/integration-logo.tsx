'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { logoSources } from './brand-logo-sources'

/**
 * Brand logo for an integration/MCP provider.
 *
 * Sources are resolved (and documented) in brand-logo-sources: bundled asset →
 * catalogue-supplied URL → Simple Icons → the brand's favicon. Each load error
 * advances to the next, so a missing logo never leaves a broken image, and only
 * a provider that fails every source falls back to a monochrome initial tile.
 */
export function IntegrationLogo({
  src,
  slug,
  name,
  className,
}: {
  src?: string | null
  slug?: string | null
  name: string
  className?: string
}) {
  const sources = logoSources({ src, slug })
  const [failed, setFailed] = useState(0)

  const box = cn('flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded', className)
  const current = sources[failed]

  if (current) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        key={current}
        src={current}
        alt=""
        className={box}
        onError={() => setFailed((index) => index + 1)}
      />
    )
  }

  return (
    <span
      className={cn(box, 'bg-gray-100 text-[11px] font-semibold uppercase text-gray-600')}
      aria-hidden
    >
      {name.trim().charAt(0) || '?'}
    </span>
  )
}
