import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectHuddleStart, ringNotification, type HuddleParticipant } from '../huddle-alerts'

const p = (clientId: string, name: string, inHuddle = false): HuddleParticipant => ({ clientId, name, inHuddle })

test('a huddle starting names the person who started it', () => {
  const prev = [p('a', 'Ada'), p('b', 'Bo')]
  const next = [p('a', 'Ada', true), p('b', 'Bo')]
  assert.equal(detectHuddleStart(prev, next, 'me', false), 'Ada')
})

test('later joiners are silent — one toast per huddle, not one per person', () => {
  const prev = [p('a', 'Ada', true), p('b', 'Bo')]
  const next = [p('a', 'Ada', true), p('b', 'Bo', true)]
  assert.equal(detectHuddleStart(prev, next, 'me', false), null)
})

test('two people flipping in the same tick is still one start', () => {
  const prev = [p('a', 'Ada'), p('b', 'Bo')]
  const next = [p('a', 'Ada', true), p('b', 'Bo', true)]
  assert.equal(detectHuddleStart(prev, next, 'me', false), 'Ada')
})

test('being in the huddle yourself suppresses the toast', () => {
  const prev = [p('a', 'Ada')]
  const next = [p('a', 'Ada', true)]
  assert.equal(detectHuddleStart(prev, next, 'me', true), null)
})

test('your own presence never counts as someone else starting', () => {
  // Self is filtered out, so the ordering of setJoined/setInHuddle cannot matter.
  const prev = [p('me', 'Me')]
  const next = [p('me', 'Me', true)]
  assert.equal(detectHuddleStart(prev, next, 'me', false), null)
})

test('no change and empty rooms are silent', () => {
  assert.equal(detectHuddleStart([], [], 'me', false), null)
  const same = [p('a', 'Ada', true)]
  assert.equal(detectHuddleStart(same, same, 'me', false), null)
})

test('a huddle ending then restarting toasts again', () => {
  const live = [p('a', 'Ada', true)]
  const ended = [p('a', 'Ada')]
  assert.equal(detectHuddleStart(live, ended, 'me', false), null)
  assert.equal(detectHuddleStart(ended, live, 'me', false), 'Ada')
})

test('jam copy is unchanged from what the endpoint sends today', () => {
  const out = ringNotification('jam', 'Ada', 'Weekly rollup', 'f1')
  assert.equal(out.type, 'flow.jam_invite')
  assert.equal(out.title, 'Ada invited you to jam')
  assert.equal(out.body, 'Join “Weekly rollup” to edit it together in real time.')
  assert.equal(out.link, '/flows/f1')
  assert.equal(out.level, 'action')
})

test('huddle copy names the huddle and links to the flow', () => {
  const out = ringNotification('huddle', 'Ada', 'Weekly rollup', 'f1')
  assert.equal(out.type, 'flow.huddle_started')
  assert.equal(out.title, 'Ada started a huddle')
  assert.match(out.body, /voice huddle/i)
  assert.equal(out.link, '/flows/f1')
})

test('no copy uses raw token syntax', () => {
  for (const kind of ['jam', 'huddle'] as const) {
    const out = ringNotification(kind, 'Ada', 'Flow', 'f1')
    assert.ok(!/\{\{|\}\}/.test(`${out.title} ${out.body}`), kind)
  }
})
