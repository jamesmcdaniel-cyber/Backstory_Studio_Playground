'use client'

/**
 * The one filter bar every library grid runs on: agent templates, skills, and
 * the flow-template gallery on the Flows page.
 *
 * It replaced two different controls. The Templates library led with an AI
 * finder — a prompt box you had to press Enter on, which answered with a
 * separate suggestions panel rather than filtering the grid you were looking at
 * — and both libraries listed their categories as a wrapping row of pills that
 * ran to two lines and pushed the cards below the fold. Category is a dropdown
 * now, and Role sits beside it, so the whole control is one line whatever the
 * catalogue grows to.
 *
 * Role is DERIVED, not stored — see src/lib/templates/roles.ts for why and how.
 */

import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ROLES, ALL_ROLES } from '@/lib/templates/roles'

/**
 * The "everything" choice both dropdowns fall back to. Radix forbids an empty
 * item value, so the sentinel is a word — the same one `hasRole` treats as
 * "no role filter", re-exported here so a grid needs one import to filter.
 */
export const ALL_FILTER = ALL_ROLES

export function LibraryFilterBar({
  search,
  onSearchChange,
  searchPlaceholder = 'Search automations, use cases, or delivery patterns…',
  searchLabel = 'Search the library',
  categories,
  category,
  onCategoryChange,
  role,
  onRoleChange,
}: {
  search: string
  onSearchChange: (value: string) => void
  searchPlaceholder?: string
  searchLabel?: string
  /** The real categories present in the grid, without the "All" entry. */
  categories: string[]
  category: string
  onCategoryChange: (value: string) => void
  role: string
  onRoleChange: (value: string) => void
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card p-3 shadow-1 sm:p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:gap-5">
        <div className="relative min-w-0 flex-1">
          <Search aria-hidden className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            // type/name/autoComplete: without these, browser autofill treats a
            // bare text input as an identity field and pre-fills the user's
            // saved email — which silently filters the grid to nothing.
            type="search"
            name="library-search"
            autoComplete="off"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchLabel}
            className="h-11 w-full rounded-full pl-11 pr-10 [&::-webkit-search-cancel-button]:hidden"
          />
          {search && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => onSearchChange('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <FilterSelect
            id="library-category"
            label="Category"
            value={category}
            onChange={onCategoryChange}
            allLabel="All categories"
            options={categories}
            className="w-[13rem]"
          />
          <FilterSelect
            id="library-role"
            label="Role"
            value={role}
            onChange={onRoleChange}
            allLabel="All roles"
            options={[...ROLES]}
            className="w-[10rem]"
          />
        </div>
      </div>
    </div>
  )
}

function FilterSelect({
  id,
  label,
  value,
  onChange,
  allLabel,
  options,
  className,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  allLabel: string
  options: string[]
  className?: string
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {/* A real label element, not decorative text: the trigger is a button, so
          without this the dropdown is announced with no name at all. */}
      <span id={`${id}-label`} className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} aria-labelledby={`${id}-label ${id}`} className={`h-10 shrink-0 rounded-full ${className ?? ''}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_FILTER}>{allLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option} value={option}>{option}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
