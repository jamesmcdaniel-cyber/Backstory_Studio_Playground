/**
 * Deterministic "human coworker" avatar features for an agent, derived from
 * its id. Pure data (no React) so the picker is unit-testable and the same
 * agent renders the same face everywhere, forever — no stored image, no
 * network fetch, no new dependency.
 */

export type AvatarFeatures = {
  skin: string
  hair: string
  hairStyle: 'crop' | 'part' | 'curly' | 'bun' | 'long' | 'bald'
  shirt: string
  background: string
  accessory: 'none' | 'glasses' | 'earring'
}

const SKIN_TONES = ['#F6D3B3', '#EAB58F', '#D29B6E', '#A96F44', '#8D5524', '#5C3A21']
const HAIR_COLORS = ['#26303E', '#4B3621', '#8A5A1B', '#A13232', '#57606E']
const HAIR_STYLES: AvatarFeatures['hairStyle'][] = ['crop', 'part', 'curly', 'bun', 'long', 'bald']
// Shirt and background are picked as a PAIR so every combination stays in one
// hue family — coherent tiles instead of clashing confetti.
const OUTFITS: Array<{ shirt: string; background: string }> = [
  { shirt: '#6366F1', background: '#EEF2FF' }, // indigo
  { shirt: '#0284C7', background: '#F0F9FF' }, // sky
  { shirt: '#059669', background: '#ECFDF5' }, // emerald
  { shirt: '#D97706', background: '#FFFBEB' }, // amber
  { shirt: '#E11D48', background: '#FFF1F2' }, // rose
  { shirt: '#7C3AED', background: '#F5F3FF' }, // violet
]
const ACCESSORIES: AvatarFeatures['accessory'][] = ['none', 'glasses', 'earring', 'none']

/** FNV-1a — tiny, stable, and spreads short cuids well enough for this. */
function fnv1a(seed: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function avatarFeatures(seed: string): AvatarFeatures {
  const hash = fnv1a(seed)
  const outfit = OUTFITS[(hash >>> 9) % OUTFITS.length]
  return {
    skin: SKIN_TONES[hash % SKIN_TONES.length],
    hair: HAIR_COLORS[(hash >>> 3) % HAIR_COLORS.length],
    hairStyle: HAIR_STYLES[(hash >>> 6) % HAIR_STYLES.length],
    shirt: outfit.shirt,
    background: outfit.background,
    accessory: ACCESSORIES[(hash >>> 13) % ACCESSORIES.length],
  }
}
