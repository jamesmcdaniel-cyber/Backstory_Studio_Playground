// ── Card accent recipes ──────────────────────────────────────────────────
// A small palette of accents; a category is deterministically hashed to one so
// the same category always gets the same color everywhere it appears — the
// templates library and the Flows-page gallery stay visually consistent.
// Full literal class strings: Tailwind's JIT only sees statically analyzable
// names, so no interpolation.
export const ACCENTS = [
  { bar: 'from-sky-500 to-cyan-400',       tile: 'bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300',           badge: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300',           ring: 'hover:ring-sky-300/70 dark:hover:ring-sky-500/40' },
  { bar: 'from-violet-500 to-fuchsia-400', tile: 'bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300', badge: 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300', ring: 'hover:ring-violet-300/70 dark:hover:ring-violet-500/40' },
  { bar: 'from-emerald-500 to-teal-400',   tile: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300', badge: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300', ring: 'hover:ring-emerald-300/70 dark:hover:ring-emerald-500/40' },
  { bar: 'from-amber-500 to-orange-400',   tile: 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',     badge: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',     ring: 'hover:ring-amber-300/70 dark:hover:ring-amber-500/40' },
  { bar: 'from-rose-500 to-pink-400',      tile: 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300',         badge: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300',         ring: 'hover:ring-rose-300/70 dark:hover:ring-rose-500/40' },
  { bar: 'from-indigo-500 to-blue-400',    tile: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300', badge: 'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300', ring: 'hover:ring-indigo-300/70 dark:hover:ring-indigo-500/40' },
] as const

export type CardAccent = (typeof ACCENTS)[number]

function hashIndex(seed: string, mod: number): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return h % mod
}

export function accentFor(category: string): CardAccent {
  return ACCENTS[hashIndex(category || 'default', ACCENTS.length)]
}
