import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CARD_ACCENTS, cardAccent } from '@/lib/flows/card-accent'

test('the same id always yields the same accent', () => {
  const id = 'flow_c1a2b3'
  const first = cardAccent(id)
  assert.equal(cardAccent(id), first)
  assert.equal(cardAccent(id), first)
})

test('different ids spread across the palette', () => {
  const ids = Array.from({ length: 60 }, (_, i) => `flow_${i}`)
  const used = new Set(ids.map((id) => cardAccent(id).bar))
  assert.ok(used.size > 1, 'every id landed on one accent — the hash is not spreading')
})

test('an empty id still resolves to a real recipe', () => {
  assert.equal(cardAccent(''), CARD_ACCENTS[0])
})

test('every recipe is a full literal class string Tailwind can see', () => {
  for (const accent of CARD_ACCENTS) {
    for (const value of Object.values(accent)) {
      assert.equal(typeof value, 'string')
      assert.ok(!value.includes('${'), `interpolated class string: ${value}`)
      assert.ok(value.trim().length > 0)
    }
  }
})
