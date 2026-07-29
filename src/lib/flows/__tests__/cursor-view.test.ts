import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeParticipantView } from '../cursor-view'

test('a teammate in the other view is labelled and marked as needing a follow', () => {
  assert.deepEqual(describeParticipantView({ view: 'canvas' }, 'inline'), { label: 'Canvas view', needsFollow: true })
  assert.deepEqual(describeParticipantView({ view: 'inline' }, 'canvas'), { label: 'Inline view', needsFollow: true })
})

test('a teammate in my view needs no follow and carries no label', () => {
  assert.deepEqual(describeParticipantView({ view: 'inline' }, 'inline'), { label: '', needsFollow: false })
  assert.deepEqual(describeParticipantView({ view: 'canvas' }, 'canvas'), { label: '', needsFollow: false })
})

test('a participant from a client that predates view-in-presence is assumed to be with me', () => {
  assert.deepEqual(describeParticipantView({}, 'canvas'), { label: '', needsFollow: false })
})
