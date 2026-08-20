/**
 * Demo-mode free-text anonymiser.
 *
 * Two passes, in a deliberate order:
 *
 *  1. Alias-book sweep — every real value the snapshot has aliased (company
 *     names, people, emails) is replaced wherever it appears in prose,
 *     longest-first so "Acme Corp International" is not half-eaten by its
 *     "Acme Corp" substring, case-insensitively because prose does not spell
 *     names the way the CRM does.
 *  2. Detector sweep — anything PII-shaped the book has no entry for (an email
 *     in a pasted thread, a phone number in a note) is caught by the detectors
 *     from src/lib/security/pii-egress.ts and replaced with book-GENERATED
 *     values, so even unmapped PII leaves as fiction, deterministically.
 *
 * Pure: no DB, no env, no clock. Same contract as the alias book it consumes.
 */

import { PII_DETECTORS } from '@/lib/security/pii-egress'
import type { AliasBook } from './alias'

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function anonymizeText(text: string, book: AliasBook): string {
  if (!text) return text
  let out = text

  // Pass 1: known real values, longest first. Skip entries whose alias
  // contains the needle (never true today — aliases share nothing with their
  // real value — but a guard against a future dictionary collision looping).
  const entries = [...book.entries()].sort((a, b) => b[0].length - a[0].length)
  for (const [real, alias] of entries) {
    if (real.length < 3) continue // a 1-2 char needle shreds unrelated prose
    if (alias.toLowerCase().includes(real)) continue
    out = out.replace(new RegExp(escapeRegExp(real), 'gi'), alias)
  }

  // Pass 2: PII-shaped strays. Replacements come from the book, so the same
  // stray maps to the same fiction everywhere. Category-specific generators;
  // aliases produced here are themselves detector-clean (checked for email:
  // generated addresses ARE emails, so replace only when the match is not
  // already one of our aliases).
  const aliasValues = new Set([...book.entries().values()].map((value) => value.toLowerCase()))
  // A detector can re-match a FRAGMENT of a value this function already
  // generated (the tail digits of an aliased phone number, say), and replacing
  // a fragment of fiction with more fiction breaks idempotence — running the
  // anonymiser twice must be a no-op. The map is small (one workspace's
  // aliases), so a containment scan is fine.
  const isAliasFragment = (match: string) => {
    const needle = match.toLowerCase()
    if (aliasValues.has(needle)) return true
    for (const alias of aliasValues) if (alias.includes(needle)) return true
    return false
  }
  for (const detector of PII_DETECTORS) {
    out = out.replace(new RegExp(detector.pattern.source, `${detector.pattern.flags.replace('g', '')}g`), (match) => {
      if (detector.confirm && !detector.confirm(match)) return match
      if (isAliasFragment(match)) return match
      switch (detector.category) {
        case 'email': {
          const generated = book.person({ name: null, email: match, companyName: null }).email
          if (generated) aliasValues.add(generated.toLowerCase())
          return generated ?? match
        }
        case 'phone': {
          const generated = book.phone(match)
          aliasValues.add(generated.toLowerCase())
          return generated
        }
        case 'credit_card':
          return book.cardNumber(match)
        case 'national_id':
          return book.nationalId(match)
        case 'ip_address': {
          const generated = book.ip(match)
          aliasValues.add(generated.toLowerCase())
          return generated
        }
        case 'street_address':
          return book.streetAddress(match)
      }
    })
  }

  return out
}

/** Deep-walk a JSON value; strings pass through anonymizeText, keys untouched. */
export function anonymizeJson(value: unknown, book: AliasBook): unknown {
  if (typeof value === 'string') return anonymizeText(value, book)
  if (Array.isArray(value)) return value.map((item) => anonymizeJson(item, book))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, anonymizeJson(item, book)]),
    )
  }
  return value
}
