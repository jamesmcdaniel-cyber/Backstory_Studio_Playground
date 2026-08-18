import { test } from 'node:test'
import assert from 'node:assert/strict'
import { avatarFeatures } from '../avatar'

test('is deterministic: same seed, same features', () => {
  assert.deepEqual(avatarFeatures('cmagent123'), avatarFeatures('cmagent123'))
})

test('different seeds produce variety across a realistic population', () => {
  const seeds = Array.from({ length: 40 }, (_, index) => `cm${index}agentseed${index * 7}`)
  const looks = new Set(seeds.map((seed) => JSON.stringify(avatarFeatures(seed))))
  // Not a strict uniqueness claim — just that the picker actually spreads.
  assert.ok(looks.size > 20, `expected variety, got ${looks.size} distinct looks`)
})

test('every feature is drawn from its palette (valid colors, known styles)', () => {
  for (const seed of ['a', 'b', 'zz-top', 'cmf00']) {
    const features = avatarFeatures(seed)
    assert.match(features.skin, /^#[0-9A-F]{6}$/i)
    assert.match(features.hair, /^#[0-9A-F]{6}$/i)
    assert.match(features.shirt, /^#[0-9A-F]{6}$/i)
    assert.match(features.background, /^#[0-9A-F]{6}$/i)
    assert.ok(['crop', 'part', 'curly', 'bun', 'long', 'bald'].includes(features.hairStyle))
    assert.ok(['none', 'glasses', 'earring'].includes(features.accessory))
  }
})
