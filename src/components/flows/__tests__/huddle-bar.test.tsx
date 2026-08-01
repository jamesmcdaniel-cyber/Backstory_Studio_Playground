import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen } from '@testing-library/react'
import { HuddleBar } from '../huddle-bar'

const noop = () => {}
const base = {
  joined: false,
  connecting: false,
  muted: false,
  members: [],
  speakingIds: new Set<string>(),
  onJoin: noop,
  onLeave: noop,
  onToggleMute: noop,
}

test('renders nothing when idle with no error', () => {
  const { container } = render(<HuddleBar {...base} />)
  assert.equal(container.firstChild, null)
  cleanup()
})

test('a mic error is visible even when nobody is in the huddle', () => {
  render(
    <HuddleBar
      {...base}
      error={{ title: 'Microphone access is blocked', hint: 'Allow microphone access from the icon in your browser’s address bar, then join again.', retryable: false }}
      onDismissError={noop}
    />,
  )
  assert.ok(screen.getByRole('alert'))
  assert.ok(screen.getByText('Microphone access is blocked'))
  cleanup()
})

test('members still render the huddle controls', () => {
  render(<HuddleBar {...base} joined members={[{ clientId: 'a', name: 'Ada', color: '#f00' }]} />)
  assert.ok(screen.getByLabelText('Leave huddle'))
  cleanup()
})

test('push-to-talk replaces the mute button rather than sitting beside it', () => {
  render(
    <HuddleBar
      {...base}
      joined
      pttEnabled
      onTogglePtt={noop}
      members={[{ clientId: 'a', name: 'Ada', color: '#f00' }]}
    />,
  )
  assert.equal(screen.queryByLabelText('Mute'), null, 'no competing mute control')
  assert.ok(screen.getByLabelText('Turn off push to talk'))
  cleanup()
})

test('with push-to-talk off both mute and the PTT toggle are offered', () => {
  render(
    <HuddleBar
      {...base}
      joined
      onTogglePtt={noop}
      members={[{ clientId: 'a', name: 'Ada', color: '#f00' }]}
    />,
  )
  assert.ok(screen.getByLabelText('Mute'))
  assert.ok(screen.getByLabelText('Turn on push to talk'))
  cleanup()
})

test('the live indicator only appears while actually transmitting', () => {
  render(<HuddleBar {...base} joined pttEnabled onTogglePtt={noop} members={[{ clientId: 'a', name: 'Ada', color: '#f00' }]} />)
  assert.ok(screen.getByText('Hold Space'))
  cleanup()
  render(<HuddleBar {...base} joined pttEnabled transmitting onTogglePtt={noop} members={[{ clientId: 'a', name: 'Ada', color: '#f00' }]} />)
  assert.ok(screen.getByText('Live'))
  cleanup()
})
