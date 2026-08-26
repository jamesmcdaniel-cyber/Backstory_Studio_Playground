import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeAppend, mergeByKey } from '../merge'

test('mergeAppend concatenates list inputs into one flat list', () => {
  assert.deepEqual(mergeAppend([[1, 2], [3, 4]]), [1, 2, 3, 4])
})

test('mergeAppend wraps non-list inputs as single items', () => {
  assert.deepEqual(mergeAppend(['a', [1, 2]]), ['a', 1, 2])
})

test('mergeAppend parses JSON-string list inputs (step outputs arrive structured or as text)', () => {
  assert.deepEqual(mergeAppend(['["a","b"]', ['c']]), ['a', 'b', 'c'])
})

test('mergeByKey full-outer-joins record lists on a shared key, later wins', () => {
  const a = [{ email: 'x@a.com', name: 'X' }, { email: 'y@a.com', name: 'Y' }]
  const b = [{ email: 'x@a.com', phone: '111' }, { email: 'z@a.com', phone: '999' }]
  assert.deepEqual(mergeByKey([a, b], 'email'), [
    { email: 'x@a.com', name: 'X', phone: '111' },
    { email: 'y@a.com', name: 'Y' },
    { email: 'z@a.com', phone: '999' },
  ])
})

test('mergeByKey keeps records missing the key as their own rows', () => {
  const a = [{ id: 1, v: 'a' }]
  const b = [{ v: 'no-key' }]
  assert.deepEqual(mergeByKey([a, b], 'id'), [{ id: 1, v: 'a' }, { v: 'no-key' }])
})

test('mergeByKey preserves first-seen key order', () => {
  const a = [{ k: 'b' }, { k: 'a' }]
  const b = [{ k: 'a', extra: 1 }]
  assert.deepEqual(mergeByKey([a, b], 'k'), [{ k: 'b' }, { k: 'a', extra: 1 }])
})

// ── Join modes, dual keys, clash handling ──────────────────────────────────

const accounts = [{ id: 'a1', name: 'Acme', owner: 'Alex' }, { id: 'a2', name: 'Beta', owner: 'Sam' }]
const crm = [{ id: 'a1', name: 'ACME CORP', arr: 120_000 }, { id: 'a3', name: 'Gamma', arr: 5_000 }]

/**
 * We had two of n8n's five output types, expressed as a boolean: includeUnpaired
 * true was keepEverything, false was keepMatches. The three it could not say are
 * the ones a sales flow actually reaches for.
 */

test('the boolean every saved flow carries still means what it meant', () => {
  assert.equal(mergeByKey([accounts, crm], 'id', true).length, 3, 'true was full outer')
  assert.equal(mergeByKey([accounts, crm], 'id', false).length, 1, 'false was inner')
})

test('enrichInput1 is a left join — every account, enriched where CRM matched', () => {
  // The single most common merge in a sales flow, and previously unreachable:
  // includeUnpaired=true also drags in CRM rows with no account.
  const out = mergeByKey([accounts, crm], 'id', true, { joinMode: 'enrichInput1' }) as Record<string, unknown>[]
  assert.deepEqual(out.map((r) => r.id), ['a1', 'a2'])
  assert.equal(out[0].arr, 120_000, 'the matched one gained CRM data')
  assert.equal(out[1].arr, undefined, 'the unmatched one came through unenriched')
})

test('enrichInput2 is the right join', () => {
  const out = mergeByKey([accounts, crm], 'id', true, { joinMode: 'enrichInput2' }) as Record<string, unknown>[]
  assert.deepEqual(out.map((r) => r.id), ['a1', 'a3'])
})

test('keepNonMatches answers "what did NOT match" — an anti-join', () => {
  // Finding the gap is a question the boolean could not ask at all.
  const out = mergeByKey([accounts, crm], 'id', true, { joinMode: 'keepNonMatches' }) as Record<string, unknown>[]
  assert.deepEqual(out.map((r) => r.id), ['a2', 'a3'])
})

test('keepMatches means present in EVERY input, not merely more than one', () => {
  // The old code asked for "seen in more than one input", which is the same
  // thing for two inputs and quietly wrong for three.
  const third = [{ id: 'a1', tier: 'gold' }]
  const all = mergeByKey([accounts, crm, third], 'id', false) as Record<string, unknown>[]
  assert.deepEqual(all.map((r) => r.id), ['a1'])

  const onlyInTwo = mergeByKey([accounts, crm, [{ id: 'zz' }]], 'id', false) as Record<string, unknown>[]
  assert.deepEqual(onlyInTwo.map((r) => r.id), [], 'a1 is in two of three, and two of three is not all of them')
})

test('the two sides can match on differently-named fields', () => {
  // `email` here, `emailAddress` there. Requiring one name for both sides meant
  // these two lists simply could not be joined.
  const left = [{ email: 'a@x.test', plan: 'pro' }]
  const right = [{ emailAddress: 'a@x.test', seats: 12 }]
  const out = mergeByKey([left, right], 'email', true, {
    keyRight: 'emailAddress',
    joinMode: 'keepMatches',
  }) as Record<string, unknown>[]
  assert.equal(out.length, 1)
  assert.equal(out[0].seats, 12)
  assert.equal(out[0].plan, 'pro')
})

test('clash handling decides which side wins a shared field', () => {
  // It was always preferLast, silently: the CRM name overwrote the account's.
  const last = mergeByKey([accounts, crm], 'id', false) as Record<string, unknown>[]
  assert.equal(last[0].name, 'ACME CORP')

  const first = mergeByKey([accounts, crm], 'id', false, { clash: 'preferFirst' }) as Record<string, unknown>[]
  assert.equal(first[0].name, 'Acme', 'the first input keeps its own value')
})

test('deepMerge combines nested objects instead of replacing them', () => {
  const left = [{ id: 'a1', meta: { region: 'EMEA', tier: 'gold' } }]
  const right = [{ id: 'a1', meta: { tier: 'platinum', owner: 'Sam' } }]
  const out = mergeByKey([left, right], 'id', false, { clash: 'deepMerge' }) as Record<string, unknown>[]
  assert.deepEqual(out[0].meta, { region: 'EMEA', tier: 'platinum', owner: 'Sam' })
})

test('keyless records travel only with the modes that keep unmatched rows', () => {
  const withLoose = [{ id: 'a1' }, { noKey: true }]
  assert.equal((mergeByKey([withLoose, crm], 'id', true) as unknown[]).length, 3)
  assert.ok(!(mergeByKey([withLoose, crm], 'id', false) as Record<string, unknown>[]).some((r) => r.noKey))
})
