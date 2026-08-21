export type AvatarAsset = {
  id: string
  src: string
  label: string
  background: string
}

/**
 * The authored 3D portrait library. IDs are persisted as avatar seeds, so keep
 * them stable and append new portraits rather than reordering existing ones.
 */
export const AVATAR_ASSETS: readonly AvatarAsset[] = [
  { id: 'bs-3d-v1-01', src: '/avatars/3d/01-cobalt-operator.webp', label: 'Cobalt operator', background: '#E0E7FF' },
  { id: 'bs-3d-v1-02', src: '/avatars/3d/02-amber-architect.webp', label: 'Amber architect', background: '#FFEDD5' },
  { id: 'bs-3d-v1-03', src: '/avatars/3d/03-mint-strategist.webp', label: 'Mint strategist', background: '#D1FAE5' },
  { id: 'bs-3d-v1-04', src: '/avatars/3d/04-magenta-producer.webp', label: 'Magenta producer', background: '#FCE7F3' },
  { id: 'bs-3d-v1-05', src: '/avatars/3d/05-teal-researcher.webp', label: 'Teal researcher', background: '#CCFBF1' },
  { id: 'bs-3d-v1-06', src: '/avatars/3d/06-indigo-builder.webp', label: 'Indigo builder', background: '#E0E7FF' },
  { id: 'bs-3d-v1-07', src: '/avatars/3d/07-coral-planner.webp', label: 'Coral planner', background: '#FFE4E6' },
  { id: 'bs-3d-v1-08', src: '/avatars/3d/08-lime-analyst.webp', label: 'Lime analyst', background: '#ECFCCB' },
  { id: 'bs-3d-v1-09', src: '/avatars/3d/09-violet-designer.webp', label: 'Violet designer', background: '#EDE9FE' },
  { id: 'bs-3d-v1-10', src: '/avatars/3d/10-sky-mentor.webp', label: 'Sky mentor', background: '#E0F2FE' },
  { id: 'bs-3d-v1-11', src: '/avatars/3d/11-tangerine-lead.webp', label: 'Tangerine lead', background: '#FFEDD5' },
  { id: 'bs-3d-v1-12', src: '/avatars/3d/12-rose-writer.webp', label: 'Rose writer', background: '#FFE4E6' },
  { id: 'bs-3d-v1-13', src: '/avatars/3d/13-aqua-engineer.webp', label: 'Aqua engineer', background: '#CFFAFE' },
  { id: 'bs-3d-v1-14', src: '/avatars/3d/14-chartreuse-growth.webp', label: 'Chartreuse growth', background: '#ECFCCB' },
  { id: 'bs-3d-v1-15', src: '/avatars/3d/15-ruby-operator.webp', label: 'Ruby operator', background: '#FFE4E6' },
  { id: 'bs-3d-v1-16', src: '/avatars/3d/16-navy-director.webp', label: 'Navy director', background: '#E0E7FF' },
  { id: 'bs-3d-v1-17', src: '/avatars/3d/17-sunshine-success.webp', label: 'Sunshine success', background: '#FEF3C7' },
  { id: 'bs-3d-v1-18', src: '/avatars/3d/18-plum-scientist.webp', label: 'Plum scientist', background: '#F3E8FF' },
  { id: 'bs-3d-v1-19', src: '/avatars/3d/19-emerald-advisor.webp', label: 'Emerald advisor', background: '#D1FAE5' },
  { id: 'bs-3d-v1-20', src: '/avatars/3d/20-periwinkle-pm.webp', label: 'Periwinkle PM', background: '#E0E7FF' },
  { id: 'bs-3d-v1-21', src: '/avatars/3d/21-pink-community.webp', label: 'Pink community', background: '#FCE7F3' },
  { id: 'bs-3d-v1-22', src: '/avatars/3d/22-bronze-security.webp', label: 'Bronze security', background: '#FFEDD5' },
  { id: 'bs-3d-v1-23', src: '/avatars/3d/23-lavender-coach.webp', label: 'Lavender coach', background: '#F3E8FF' },
  { id: 'bs-3d-v1-24', src: '/avatars/3d/24-turquoise-data.webp', label: 'Turquoise data', background: '#CCFBF1' },
] as const

const EXPLICIT_ASSET_PATTERN = /^bs-3d-v1-(\d{2})$/

/** FNV-1a keeps every pre-library avatar seed mapped to a stable portrait. */
function avatarSeedHash(seed: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Existing arbitrary seeds keep working; new picker choices use explicit IDs. */
export function avatarAssetIndex(seed: string): number {
  const match = seed.match(EXPLICIT_ASSET_PATTERN)
  if (match) {
    const explicitIndex = Number(match[1]) - 1
    if (explicitIndex >= 0 && explicitIndex < AVATAR_ASSETS.length) return explicitIndex
  }
  return avatarSeedHash(seed) % AVATAR_ASSETS.length
}

export function avatarAssetForSeed(seed: string): AvatarAsset {
  return AVATAR_ASSETS[avatarAssetIndex(seed)]
}
