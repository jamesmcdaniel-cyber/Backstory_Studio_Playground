import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_FEATURES,
  FEATURES,
  isFeature,
  resolveFeatures,
  scopeOf,
  type FeatureGrantRow,
} from '../features'

/**
 * Precedence is the whole design, and the case that decides it is a withdrawn
 * feature: a workspace-wide "off" must not be re-enabled by a stale team pilot
 * grant nobody remembers. That is why deny wins globally rather than
 * narrowest-scope-wins, which reads as more sophisticated and gets that case
 * wrong.
 */

const USER = 'user_1'
const grant = (over: Partial<FeatureGrantRow>): FeatureGrantRow => ({
  feature: 'huddles.voice',
  enabled: true,
  teamId: null,
  userId: null,
  ...over,
})

test('defaults apply with no grants at all', () => {
  const features = resolveFeatures({ grants: [], userId: USER, teamIds: [] })
  for (const feature of DEFAULT_FEATURES) {
    assert.ok(features.has(feature), `${feature} should be on by default`)
  }
})

test('a workspace grant reaches everyone in it', () => {
  const features = resolveFeatures({ grants: [grant({})], userId: USER, teamIds: [] })
  assert.ok(features.has('huddles.voice'))
})

test('a team grant reaches only members of that team', () => {
  const grants = [grant({ teamId: 'team_a' })]

  assert.ok(resolveFeatures({ grants, userId: USER, teamIds: ['team_a'] }).has('huddles.voice'))
  assert.ok(!resolveFeatures({ grants, userId: USER, teamIds: ['team_b'] }).has('huddles.voice'))
  assert.ok(!resolveFeatures({ grants, userId: USER, teamIds: [] }).has('huddles.voice'))
})

test('a user grant reaches only that person', () => {
  const grants = [grant({ userId: 'someone_else' })]
  assert.ok(!resolveFeatures({ grants, userId: USER, teamIds: [] }).has('huddles.voice'))

  const mine = [grant({ userId: USER })]
  assert.ok(resolveFeatures({ grants: mine, userId: USER, teamIds: [] }).has('huddles.voice'))
})

test('a user-level DENY beats a workspace grant', () => {
  // The exception has to be expressible, or the only way to exclude one person
  // is to stop granting the feature to everyone.
  const grants = [grant({}), grant({ userId: USER, enabled: false })]
  assert.ok(!resolveFeatures({ grants, userId: USER, teamIds: [] }).has('huddles.voice'))
})

test('a workspace DENY beats a team grant — the withdrawn-feature case', () => {
  // Narrowest-scope-wins would re-enable a withdrawn feature via a stale pilot
  // grant. This is the case that decided the rule.
  const grants = [grant({ enabled: false }), grant({ teamId: 'team_a' })]
  assert.ok(!resolveFeatures({ grants, userId: USER, teamIds: ['team_a'] }).has('huddles.voice'))
})

test('a DENY can switch off a default feature', () => {
  const grants = [grant({ feature: 'flows.copilot', enabled: false })]
  const features = resolveFeatures({ grants, userId: USER, teamIds: [] })
  assert.ok(!features.has('flows.copilot'))
})

test('a deny scoped to someone else does not affect this person', () => {
  const grants = [grant({}), grant({ userId: 'someone_else', enabled: false })]
  assert.ok(resolveFeatures({ grants, userId: USER, teamIds: [] }).has('huddles.voice'))
})

test('unknown feature keys are ignored rather than granted', () => {
  // A renamed or mistyped key must never resolve to access.
  const grants = [{ feature: 'not_a_real_feature', enabled: true, teamId: null, userId: null }]
  const features = resolveFeatures({ grants, userId: USER, teamIds: [] })
  assert.equal(features.has('not_a_real_feature' as never), false)
})

test('the registry rejects strings that are not features', () => {
  assert.equal(isFeature('huddles.voice'), true)
  assert.equal(isFeature('huddles.video'), false)
  assert.equal(isFeature(''), false)
})

test('every default feature is a registered feature', () => {
  // A default naming a feature the registry does not know would be dropped by
  // isFeature on every grant path and silently never work.
  for (const feature of DEFAULT_FEATURES) {
    assert.ok((FEATURES as readonly string[]).includes(feature), `${feature} is not in FEATURES`)
  }
})

test('scopeOf reports the scope a grant was written at', () => {
  assert.equal(scopeOf(grant({})), 'organization')
  assert.equal(scopeOf(grant({ teamId: 't' })), 'team')
  assert.equal(scopeOf(grant({ userId: 'u' })), 'user')
  // A row carrying both is a user grant: the narrower subject is the one that
  // actually identifies who it is about.
  assert.equal(scopeOf(grant({ teamId: 't', userId: 'u' })), 'user')
})
