import { useId } from 'react'
import { avatarFeatures } from '@/lib/agents/avatar'
import { cn } from '@/lib/utils'

function mixHex(base: string, overlay: string, overlayWeight: number) {
  const channel = (color: string, offset: number) => Number.parseInt(color.slice(offset, offset + 2), 16)
  const mixed = [1, 3, 5].map((offset) => {
    const value = Math.round(channel(base, offset) * (1 - overlayWeight) + channel(overlay, offset) * overlayWeight)
    return value.toString(16).padStart(2, '0')
  })
  return `#${mixed.join('')}`
}

/**
 * Polished illustrated coworker portrait, deterministic per agent id (features
 * come from @/lib/agents/avatar). It stays as an inline SVG so every surface
 * gets a crisp image at any size without an upload or network request.
 */
export function AgentAvatar({ seed, className }: { seed: string; className?: string }) {
  const look = avatarFeatures(seed)
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const clipId = `agent-avatar-clip-${instanceId}`
  const backgroundId = `agent-avatar-bg-${instanceId}`
  const skinId = `agent-avatar-skin-${instanceId}`
  const shirtId = `agent-avatar-shirt-${instanceId}`
  const shadowId = `agent-avatar-shadow-${instanceId}`
  const shirtShadow = mixHex(look.shirt, '#111827', 0.28)

  return (
    <svg
      viewBox="0 0 64 64"
      className={cn('h-16 w-16', className)}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id={clipId}>
          <circle cx="32" cy="32" r="31.5" />
        </clipPath>
        <linearGradient id={backgroundId} x1="10" y1="5" x2="54" y2="61" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFFFFF" />
          <stop offset="0.48" stopColor={look.background} />
          <stop offset="1" stopColor={look.shirt} stopOpacity="0.22" />
        </linearGradient>
        <linearGradient id={skinId} x1="24" y1="15" x2="41" y2="42" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFFFFF" stopOpacity="0.28" />
          <stop offset="0.25" stopColor={look.skin} />
          <stop offset="1" stopColor={look.skin} stopOpacity="0.88" />
        </linearGradient>
        <linearGradient id={shirtId} x1="19" y1="48" x2="46" y2="66" gradientUnits="userSpaceOnUse">
          <stop stopColor={look.shirt} />
          <stop offset="1" stopColor={shirtShadow} />
        </linearGradient>
        <filter id={shadowId} x="-30%" y="-30%" width="160%" height="170%">
          <feDropShadow dx="0" dy="1.4" stdDeviation="1.6" floodColor="#172033" floodOpacity="0.18" />
        </filter>
      </defs>

      <g clipPath={`url(#${clipId})`}>
        {/* A soft studio-style backdrop gives the portrait depth at larger sizes. */}
        <circle cx="32" cy="32" r="32" fill={`url(#${backgroundId})`} />
        <circle cx="49" cy="13" r="15" fill={look.shirt} opacity="0.07" />
        <circle cx="9" cy="47" r="18" fill="#FFFFFF" opacity="0.34" />
        <path d="M4 44 C17 33 44 31 62 42 V66 H2 Z" fill={look.shirt} opacity="0.055" />

        <g filter={`url(#${shadowId})`}>
          {/* Long hair sits behind the head and shoulders. */}
          {look.hairStyle === 'long' && (
            <g>
              <path d="M17.6 29 C17.6 11.8 46.4 11.8 46.4 29 L48.2 49 C42.4 46 21.6 46 15.8 49 Z" fill={look.hair} />
              <path d="M21 27 C21 17 25.3 13.8 31.7 13.8 C25.2 17.2 23.6 27.5 23.8 42.7" fill="#FFFFFF" opacity="0.09" />
            </g>
          )}

          {/* Tailored shoulders with a subtle lapel, instead of a flat semicircle. */}
          <path d="M10.5 65 C11.7 52.4 20.4 46.1 32 46.1 C43.6 46.1 52.3 52.4 53.5 65 Z" fill={`url(#${shirtId})`} />
          <path d="M20 49.1 L27.6 45.7 L32 51.4 L36.4 45.7 L44 49.1 L39 64 H25 Z" fill="#FFFFFF" opacity="0.12" />
          <path d="M27.6 45.7 L32 51.4 L36.4 45.7" fill="none" stroke="#FFFFFF" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" opacity="0.72" />

          {/* Neck and the small shadow under the chin make the head feel seated. */}
          <path d="M27.2 35.5 H36.8 V47 C34.2 49.1 29.8 49.1 27.2 47 Z" fill={look.skin} />
          <ellipse cx="32" cy="37" rx="4.8" ry="3.1" fill="#6B3D2E" opacity="0.12" />

          {/* Ears */}
          <ellipse cx="19.9" cy="28.2" rx="3.3" ry="4" fill={look.skin} />
          <ellipse cx="44.1" cy="28.2" rx="3.3" ry="4" fill={look.skin} />
          <path d="M19.6 27.2 C21.5 26.6 21.7 29.3 20 30" fill="none" stroke="#8B4C3B" strokeWidth="0.75" strokeLinecap="round" opacity="0.3" />
          <path d="M44.4 27.2 C42.5 26.6 42.3 29.3 44 30" fill="none" stroke="#8B4C3B" strokeWidth="0.75" strokeLinecap="round" opacity="0.3" />
          {look.accessory === 'earring' && (
            <g>
              <circle cx="44.4" cy="31.2" r="1.15" fill="#F7C948" stroke="#A16207" strokeWidth="0.35" />
              <circle cx="44.05" cy="30.85" r="0.3" fill="#FFFFFF" opacity="0.85" />
            </g>
          )}

          {/* Face */}
          <ellipse cx="32" cy="27" rx="12.2" ry="14" fill={`url(#${skinId})`} />
          <path d="M21.3 29.5 C22.4 38.1 26.3 41.1 32 41.1 C37.7 41.1 41.6 38.1 42.7 29.5" fill="none" stroke="#6B3D2E" strokeWidth="0.55" opacity="0.12" />
          <ellipse cx="24.7" cy="32" rx="2.4" ry="1.2" fill="#E97F7F" opacity="0.14" />
          <ellipse cx="39.3" cy="32" rx="2.4" ry="1.2" fill="#E97F7F" opacity="0.14" />

          {/* Hair, with small highlights that preserve detail in dark colors. */}
          {look.hairStyle === 'crop' && (
            <g>
              <path d="M19.8 26.3 C19.4 17.1 24.5 12.5 32.2 12.5 C40.2 12.5 44.8 17.6 44.1 26.6 C41.8 21.3 38 18.2 31.8 18.2 C25.9 18.2 22.5 20.8 19.8 26.3 Z" fill={look.hair} />
              <path d="M25.1 16 C29.7 13.7 36 14.1 39.9 17.7" fill="none" stroke="#FFFFFF" strokeWidth="1.2" strokeLinecap="round" opacity="0.11" />
            </g>
          )}
          {look.hairStyle === 'part' && (
            <g>
              <path d="M19.8 26.5 C19.5 17.1 24.5 12.4 32.1 12.4 C40 12.4 44.7 17.3 44.2 26.3 C41.6 20.7 38.4 18.1 34.2 17.3 L32.5 21.2 L30.5 17.1 C25.4 18 22.3 21.2 19.8 26.5 Z" fill={look.hair} />
              <path d="M33.8 14.1 C37.3 14.6 40 16.1 41.5 18.9" fill="none" stroke="#FFFFFF" strokeWidth="1.1" strokeLinecap="round" opacity="0.12" />
            </g>
          )}
          {look.hairStyle === 'curly' && (
            <g fill={look.hair}>
              <circle cx="21.7" cy="21.6" r="4.8" />
              <circle cx="25" cy="16.9" r="4.9" />
              <circle cx="31" cy="14.5" r="5" />
              <circle cx="37.2" cy="15.8" r="5.1" />
              <circle cx="42.2" cy="20.8" r="4.8" />
              <circle cx="34" cy="19" r="4.6" />
              <circle cx="27.5" cy="20" r="4.5" />
              <circle cx="27.1" cy="14.7" r="1.35" fill="#FFFFFF" opacity="0.12" />
              <circle cx="38.1" cy="15.3" r="1.25" fill="#FFFFFF" opacity="0.1" />
            </g>
          )}
          {look.hairStyle === 'bun' && (
            <g>
              <circle cx="32" cy="10.7" r="5" fill={look.hair} />
              <path d="M19.9 26.5 C19.5 17.1 24.5 12.8 32 12.8 C39.7 12.8 44.5 17.4 44.1 26.3 C41.8 20.7 38.1 18 32 18 C25.9 18 22.4 20.9 19.9 26.5 Z" fill={look.hair} />
              <path d="M28.8 9 C31 7.8 34 8.5 35.1 10.4" fill="none" stroke="#FFFFFF" strokeWidth="1.05" strokeLinecap="round" opacity="0.12" />
            </g>
          )}
          {look.hairStyle === 'long' && (
            <g>
              <path d="M19.6 27 C19.4 17 24.5 12.5 32 12.5 C39.8 12.5 44.6 17.3 44.3 27 C41.4 20.9 37.6 17.8 31.5 17.8 C25.8 17.8 22.4 20.9 19.6 27 Z" fill={look.hair} />
              <path d="M36 14.6 C39.3 15.6 41.7 18.2 42.6 21.8" fill="none" stroke="#FFFFFF" strokeWidth="1.1" strokeLinecap="round" opacity="0.11" />
            </g>
          )}

          {/* Expressive eyes: whites, irises, pupils, and highlights remain clear at 32px+. */}
          <g>
            <ellipse cx="27.3" cy="27.4" rx="2.25" ry="1.8" fill="#FFFFFF" opacity="0.92" />
            <ellipse cx="36.7" cy="27.4" rx="2.25" ry="1.8" fill="#FFFFFF" opacity="0.92" />
            <circle cx="27.45" cy="27.45" r="1.18" fill="#334155" />
            <circle cx="36.55" cy="27.45" r="1.18" fill="#334155" />
            <circle cx="27.45" cy="27.5" r="0.62" fill="#111827" />
            <circle cx="36.55" cy="27.5" r="0.62" fill="#111827" />
            <circle cx="27.05" cy="27.03" r="0.32" fill="#FFFFFF" />
            <circle cx="36.15" cy="27.03" r="0.32" fill="#FFFFFF" />
          </g>
          {/* Brows and nose use the avatar's hair color for a softer, cohesive face. */}
          <path d="M24.9 23.7 Q27.3 22.2 29.7 23.5" stroke={look.hair} strokeWidth="1.25" strokeLinecap="round" fill="none" opacity="0.78" />
          <path d="M34.3 23.5 Q36.7 22.2 39.1 23.7" stroke={look.hair} strokeWidth="1.25" strokeLinecap="round" fill="none" opacity="0.78" />
          <path d="M31.7 27.9 C31.3 30.1 30.8 31.4 32.5 31.7" fill="none" stroke="#8B4C3B" strokeWidth="0.8" strokeLinecap="round" opacity="0.42" />
          {/* A two-tone smile reads more naturally than a single dark curve. */}
          <path d="M28.3 34.2 Q32 37 35.7 34.2 Q32 38.5 28.3 34.2 Z" fill="#9F4454" opacity="0.86" />
          <path d="M29.3 34.65 Q32 35.65 34.7 34.65" fill="none" stroke="#FFFFFF" strokeWidth="0.75" strokeLinecap="round" opacity="0.88" />

          {look.accessory === 'glasses' && (
            <g stroke="#26303E" strokeWidth="1" fill="#FFFFFF" fillOpacity="0.08" opacity="0.9">
              <rect x="23.3" y="24.1" width="8.1" height="6.3" rx="2.6" />
              <rect x="32.6" y="24.1" width="8.1" height="6.3" rx="2.6" />
              <path d="M31.4 26.6 C31.8 26.2 32.2 26.2 32.6 26.6" fill="none" />
              <path d="M23.3 25.3 L20.8 24.8 M40.7 25.3 L43.2 24.8" fill="none" />
              <path d="M24.7 25.2 L27.3 24.5" stroke="#FFFFFF" strokeWidth="0.7" opacity="0.72" />
            </g>
          )}
        </g>
      </g>

      {/* Crisp inner rim helps the avatar hold its shape on white surfaces. */}
      <circle cx="32" cy="32" r="31.25" fill="none" stroke="#FFFFFF" strokeWidth="1.5" opacity="0.72" />
      <circle cx="32" cy="32" r="31.25" fill="none" stroke="#111827" strokeWidth="0.5" opacity="0.1" />
    </svg>
  )
}
