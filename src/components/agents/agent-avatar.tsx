'use client'

import Image from 'next/image'
import { useState } from 'react'
import { avatarAssetForSeed } from '@/lib/agents/avatar-assets'
import { cn } from '@/lib/utils'

/** Neutral placeholder only — it never represents a selectable identity. */
function AvatarPlaceholder() {
  return (
    <svg
      viewBox="0 0 64 64"
      className="absolute inset-0 h-full w-full animate-pulse"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="32" cy="23" r="10" fill="#64748B" opacity="0.16" />
      <path d="M13 64 C14 45 23 39 32 39 C41 39 50 45 51 64 Z" fill="#64748B" opacity="0.12" />
      <path d="M20 12 C27 5 39 5 46 12" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" opacity="0.55" />
    </svg>
  )
}

/**
 * Authored 3D portrait used by every agent surface. A neutral silhouette covers
 * loading and offline failures so the retired illustrated identities never
 * flash before the selected portrait appears.
 */
export function AgentAvatar({ seed, className }: { seed: string; className?: string }) {
  const asset = avatarAssetForSeed(seed)
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null)
  const loaded = loadedSrc === asset.src

  return (
    <span
      className={cn('relative inline-block aspect-square overflow-hidden align-middle', className)}
      style={{ background: `radial-gradient(circle at 50% 18%, #ffffff 0%, ${asset.background} 72%, #ffffff 130%)` }}
    >
      {!loaded && <AvatarPlaceholder />}
      <Image
        src={asset.src}
        alt=""
        width={512}
        height={512}
        sizes="(max-width: 640px) 96px, 128px"
        unoptimized
        onLoad={() => setLoadedSrc(asset.src)}
        onError={() => setLoadedSrc((current) => (current === asset.src ? null : current))}
        className={cn(
          'absolute inset-0 h-full w-full object-contain drop-shadow-[0_10px_10px_rgba(30,41,59,0.18)] transition-opacity duration-300',
          loaded ? 'opacity-100' : 'opacity-0',
        )}
      />
    </span>
  )
}
