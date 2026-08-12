// Decorative accent recipes for flow cards: gradient top bar, tinted icon chip,
// accent hover border, and a soft corner glow. Full literal class strings —
// Tailwind's JIT only sees statically analyzable names, so no interpolation.
//
// Shared between the Flows grid and the Assistant home's recent-flow shortcuts
// so a given flow wears the same color wherever it is shown.
export const CARD_ACCENTS = [
  {
    bar: 'from-indigo-500 to-blue-400',
    chip: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300',
    border: 'hover:border-indigo-300/70 dark:hover:border-indigo-500/40',
    glow: 'bg-indigo-400/25',
  },
  {
    bar: 'from-sky-500 to-cyan-400',
    chip: 'bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300',
    border: 'hover:border-sky-300/70 dark:hover:border-sky-500/40',
    glow: 'bg-sky-400/25',
  },
  {
    bar: 'from-violet-500 to-purple-400',
    chip: 'bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300',
    border: 'hover:border-violet-300/70 dark:hover:border-violet-500/40',
    glow: 'bg-violet-400/25',
  },
  {
    bar: 'from-emerald-500 to-teal-400',
    chip: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
    border: 'hover:border-emerald-300/70 dark:hover:border-emerald-500/40',
    glow: 'bg-emerald-400/25',
  },
  {
    bar: 'from-fuchsia-500 to-pink-400',
    chip: 'bg-fuchsia-100 text-fuchsia-600 dark:bg-fuchsia-500/15 dark:text-fuchsia-300',
    border: 'hover:border-fuchsia-300/70 dark:hover:border-fuchsia-500/40',
    glow: 'bg-fuchsia-400/25',
  },
  {
    bar: 'from-amber-500 to-orange-400',
    chip: 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',
    border: 'hover:border-amber-300/70 dark:hover:border-amber-500/40',
    glow: 'bg-amber-400/25',
  },
] as const

export type CardAccent = (typeof CARD_ACCENTS)[number]

/**
 * Keyed by a stable hash of the id, not render order, so a card keeps its
 * color across visits, pagination, folder filtering, and screens.
 */
export function cardAccent(id: string): CardAccent {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return CARD_ACCENTS[hash % CARD_ACCENTS.length]
}
