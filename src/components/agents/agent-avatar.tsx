import { avatarFeatures } from '@/lib/agents/avatar'
import { cn } from '@/lib/utils'

/**
 * Flat illustrated "coworker" bust, deterministic per agent id (features come
 * from @/lib/agents/avatar). Pure SVG — no stored image, no network, and the
 * same agent gets the same face on every surface.
 */
export function AgentAvatar({ seed, className }: { seed: string; className?: string }) {
  const look = avatarFeatures(seed)
  const clipId = `agent-avatar-${seed.replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <svg viewBox="0 0 64 64" className={cn('h-16 w-16', className)} role="img" aria-hidden="true">
      <defs>
        <clipPath id={clipId}>
          <circle cx="32" cy="32" r="32" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <circle cx="32" cy="32" r="32" fill={look.background} />
        {/* Long hair renders behind the head so it frames the face. */}
        {look.hairStyle === 'long' && (
          <path d="M18.5 27 C18.5 12.5 45.5 12.5 45.5 27 L47 46 C40 42.5 24 42.5 17 46 Z" fill={look.hair} />
        )}
        {/* Shoulders */}
        <path d="M13 64 C13 50 22 45.5 32 45.5 C42 45.5 51 50 51 64 Z" fill={look.shirt} />
        {/* Neck */}
        <rect x="27.5" y="36" width="9" height="12" rx="4" fill={look.skin} />
        {/* Ears */}
        <circle cx="20.5" cy="27.5" r="3" fill={look.skin} />
        <circle cx="43.5" cy="27.5" r="3" fill={look.skin} />
        {look.accessory === 'earring' && <circle cx="43.5" cy="30.5" r="1.2" fill="#EAB308" />}
        {/* Head */}
        <ellipse cx="32" cy="26.5" rx="12" ry="13" fill={look.skin} />
        {/* Hair, by style */}
        {look.hairStyle === 'crop' && (
          <path d="M20 26 C20 13.5 44 13.5 44 26 C44 19.5 39.5 16 32 16 C24.5 16 20 19.5 20 26 Z" fill={look.hair} />
        )}
        {look.hairStyle === 'part' && (
          <path d="M20 26 C20 13.5 44 13.5 44 26 C44 20 41 16.5 36 16 L33.5 20 L31 15.8 C24.5 16 20 19.5 20 26 Z" fill={look.hair} />
        )}
        {look.hairStyle === 'curly' && (
          <g fill={look.hair}>
            <circle cx="23" cy="20.5" r="4.6" />
            <circle cx="28.5" cy="16.8" r="4.8" />
            <circle cx="35.5" cy="16.8" r="4.8" />
            <circle cx="41" cy="20.5" r="4.6" />
            <circle cx="32" cy="15.5" r="4.4" />
          </g>
        )}
        {look.hairStyle === 'bun' && (
          <g fill={look.hair}>
            <circle cx="32" cy="11.5" r="4.5" />
            <path d="M20 26 C20 13.5 44 13.5 44 26 C44 19.5 39.5 16 32 16 C24.5 16 20 19.5 20 26 Z" />
          </g>
        )}
        {look.hairStyle === 'long' && (
          <path d="M20 27 C20 14 44 14 44 27 C44 20 39.5 16.5 32 16.5 C24.5 16.5 20 20 20 27 Z" fill={look.hair} />
        )}
        {/* Eyes */}
        <circle cx="27.5" cy="27" r="1.4" fill="#26303E" />
        <circle cx="36.5" cy="27" r="1.4" fill="#26303E" />
        {/* Brows */}
        <path d="M25.4 23.6 Q27.5 22.4 29.6 23.5" stroke="#26303E" strokeWidth="1.1" strokeLinecap="round" fill="none" opacity="0.65" />
        <path d="M34.4 23.5 Q36.5 22.4 38.6 23.6" stroke="#26303E" strokeWidth="1.1" strokeLinecap="round" fill="none" opacity="0.65" />
        {/* Smile */}
        <path d="M28.5 32.5 Q32 35.3 35.5 32.5" stroke="#26303E" strokeWidth="1.3" strokeLinecap="round" fill="none" />
        {look.accessory === 'glasses' && (
          <g stroke="#26303E" strokeWidth="1.2" fill="none" opacity="0.85">
            <circle cx="27.5" cy="27" r="3.8" />
            <circle cx="36.5" cy="27" r="3.8" />
            <path d="M31.3 27 L32.7 27" />
          </g>
        )}
        {/* Collar notch so the shirt reads as clothing, not a blob. */}
        <path d="M27 46.5 L32 51 L37 46.5" stroke="#FFFFFF" strokeOpacity="0.55" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      </g>
    </svg>
  )
}
