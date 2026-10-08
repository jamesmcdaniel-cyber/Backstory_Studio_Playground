/**
 * Reversible pseudonymisation of personal identifiers on the way to a model
 * provider, for workspaces whose AI egress policy is `redacted`.
 *
 * Emails and phone numbers in everything the model sees (system prompt, user
 * turns, tool results) become stable placeholders that keep their shape, so
 * the model can still reason about them and pass them to tools; everything
 * the model returns (text, tool inputs) has the placeholders turned back into
 * the real values before the platform acts on them. The mapping lives for
 * one run and never leaves the process. Card and national-id numbers are
 * masked outright: nothing downstream needs them whole.
 */

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
// International or North American phone numbers with at least ten digits:
// optional +, groups separated by spaces, dots, dashes or brackets.
const PHONE = /(?:(?<![\w@.])\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})(?:[\s.-]?\d{2,4}){2,4}(?!\w)/g
const CARD = /\b(?:\d[ -]?){13,19}\b/g
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g

const EMAIL_TOKEN = /\b[a-z]+(\d+)@redacted\.invalid\b/gi
const PHONE_TOKEN = /\+000 (\d{4,})\b/g

export class EgressVault {
  private readonly emails = new Map<string, string>()
  private readonly phones = new Map<string, string>()
  private readonly byToken = new Map<string, string>()

  /** How many identifiers this vault has pseudonymised. */
  get size(): number { return this.emails.size + this.phones.size }

  pseudonymize(text: string): string {
    if (!text) return text
    let out = text.replace(CARD, (match) => (match.replace(/\D/g, '').length >= 13 ? `[card ending ${match.replace(/\D/g, '').slice(-4)}]` : match))
    out = out.replace(SSN, '[national id]')
    out = out.replace(EMAIL, (match) => this.token(this.emails, match.toLowerCase(), match, (n) => `${match.split('@')[0].replace(/[^a-z]/gi, '').slice(0, 6).toLowerCase() || 'person'}${n}@redacted.invalid`))
    out = out.replace(PHONE, (match) => {
      const digits = match.replace(/\D/g, '')
      if (digits.length < 10 || digits.length > 15) return match
      return this.token(this.phones, digits, match, (n) => `+000 ${String(n).padStart(4, '0')}`)
    })
    return out
  }

  private token(map: Map<string, string>, key: string, original: string, make: (n: number) => string): string {
    const existing = map.get(key)
    if (existing) return existing
    const token = make(map.size + 1)
    map.set(key, token)
    // Restored as first seen, formatting and all.
    this.byToken.set(token.toLowerCase(), original)
    return token
  }

  restore(text: string): string {
    if (!text || !this.byToken.size) return text
    return text
      .replace(EMAIL_TOKEN, (match) => this.byToken.get(match.toLowerCase()) ?? match)
      .replace(PHONE_TOKEN, (match) => this.byToken.get(match.toLowerCase()) ?? match)
  }

  /** Pseudonymise every string in a JSON-like value, returning a copy. */
  pseudonymizeDeep<T>(value: T): T { return walk(value, (s) => this.pseudonymize(s)) }

  /** Restore every string in a JSON-like value, returning a copy. */
  restoreDeep<T>(value: T): T { return walk(value, (s) => this.restore(s)) }
}

function walk<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === 'string') return fn(value) as unknown as T
  if (Array.isArray(value)) return value.map((item) => walk(item, fn)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = walk(item, fn)
    return out as T
  }
  return value
}
