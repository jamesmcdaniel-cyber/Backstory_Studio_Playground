import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AVATAR_ASSETS, avatarAssetForSeed, avatarAssetIndex } from '../avatar-assets'

test('legacy seeds map deterministically across the 3D library', () => {
  const seeds = Array.from({ length: 40 }, (_, index) => `cm${index}agentseed${index * 7}`)
  const firstPass = seeds.map(avatarAssetIndex)
  const secondPass = seeds.map(avatarAssetIndex)
  assert.deepEqual(firstPass, secondPass)
  assert.ok(new Set(firstPass).size > 12, 'expected legacy seeds to spread across the library')
})

test('3D avatar assets map deterministically for legacy and explicit seeds', () => {
  assert.equal(AVATAR_ASSETS.length, 24)
  assert.equal(avatarAssetIndex('legacy-agent-id'), avatarAssetIndex('legacy-agent-id'))
  assert.equal(avatarAssetIndex('bs-3d-v1-01'), 0)
  assert.equal(avatarAssetIndex('bs-3d-v1-24'), 23)
  assert.equal(avatarAssetForSeed('bs-3d-v1-07').id, 'bs-3d-v1-07')
})
