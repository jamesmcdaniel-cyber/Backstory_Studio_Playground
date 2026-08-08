import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { HuddleJamPill } from '@/components/flows/huddle-jam-pill'
import type { FlowHuddle } from '@/lib/flows/use-flow-huddle'

afterEach(cleanup)

/** Only the fields the pill reads need to be real. */
const makeHuddle = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    joined: false,
    connecting: false,
    muted: false,
    pttEnabled: false,
    transmitting: false,
    join: async () => {},
    leave: () => {},
    toggleMute: () => {},
    ...over,
  }) as unknown as FlowHuddle

const baseProps = {
  huddleCount: 0,
  othersCount: 1,
  dotLevel: 'ok' as const,
  startBlocked: null,
  healthTitle: 'Flows: online',
  onOpenJam: () => {},
}

test('out of the huddle: Huddle joins, Jam opens the dialog', () => {
  let joins = 0
  let opened = 0
  render(
    <HuddleJamPill
      {...baseProps}
      huddle={makeHuddle({ join: async () => { joins += 1 } })}
      onOpenJam={() => { opened += 1 }}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: /huddle/i }))
  assert.equal(joins, 1)
  fireEvent.click(screen.getByRole('button', { name: /jam/i }))
  assert.equal(opened, 1)
})

test('starting is blocked while startBlocked gives a reason', () => {
  let joins = 0
  render(
    <HuddleJamPill
      {...baseProps}
      othersCount={0}
      startBlocked="Huddles need company — use Jam to bring someone into this flow first."
      huddle={makeHuddle({ join: async () => { joins += 1 } })}
    />,
  )
  const start = screen.getByRole('button', { name: /huddle/i })
  fireEvent.click(start)
  assert.equal(joins, 0)
  assert.equal(start.getAttribute('aria-disabled'), 'true')
  assert.match(start.getAttribute('title') ?? '', /use Jam/)
})

test('a huddle already live can be joined even while starting is blocked', () => {
  let joins = 0
  render(
    <HuddleJamPill
      {...baseProps}
      huddleCount={2}
      startBlocked="Huddles can start once the jam is connected and the dot is green."
      huddle={makeHuddle({ join: async () => { joins += 1 } })}
    />,
  )
  const join = screen.getByRole('button', { name: /huddle/i })
  assert.equal(join.getAttribute('title'), 'Join the live huddle')
  fireEvent.click(join)
  assert.equal(joins, 1)
})

test('a live huddle you are not in shows the member count', () => {
  render(<HuddleJamPill {...baseProps} huddle={makeHuddle()} huddleCount={2} />)
  const join = screen.getByRole('button', { name: /huddle/i })
  assert.match(join.textContent ?? '', /2/)
  assert.equal(join.getAttribute('title'), 'Join the live huddle')
})

test('joined: the Huddle button toggles the mic and Leave hangs up', () => {
  let mutes = 0
  let leaves = 0
  render(
    <HuddleJamPill
      {...baseProps}
      huddle={makeHuddle({ joined: true, toggleMute: () => { mutes += 1 }, leave: () => { leaves += 1 } })}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Mute' }))
  assert.equal(mutes, 1)
  fireEvent.click(screen.getByRole('button', { name: 'Leave huddle' }))
  assert.equal(leaves, 1)
})

test('joined and muted: the toggle reads Unmute', () => {
  render(<HuddleJamPill {...baseProps} huddle={makeHuddle({ joined: true, muted: true })} />)
  assert.ok(screen.getByRole('button', { name: 'Unmute' }))
})

test('push to talk stands in place of the mute toggle and opens the dialog', () => {
  let opened = 0
  render(
    <HuddleJamPill
      {...baseProps}
      huddle={makeHuddle({ joined: true, pttEnabled: true })}
      onOpenJam={() => { opened += 1 }}
    />,
  )
  const ptt = screen.getByRole('button', { name: /hold space/i })
  fireEvent.click(ptt)
  assert.equal(opened, 1)
  assert.equal(screen.queryByRole('button', { name: 'Mute' }), null)
})

test('the Jam dot reflects health and the count shows others present', () => {
  render(<HuddleJamPill {...baseProps} huddle={makeHuddle()} dotLevel="degraded" othersCount={3} />)
  assert.equal(screen.getByRole('status').getAttribute('aria-label'), 'Flow or jam health degraded')
  const jam = screen.getByRole('button', { name: /jam/i })
  assert.match(jam.textContent ?? '', /3/)
})
