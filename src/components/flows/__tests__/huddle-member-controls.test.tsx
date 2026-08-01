import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen } from '@testing-library/react'
import { act } from 'react'
import { HuddleMemberControls } from '../huddle-member-controls'

const openMenu = async () => {
  await act(async () => {
    screen.getByText('Ada').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    screen.getByText('Ada').click()
    await Promise.resolve()
  })
}

test('the slider reflects current volume and reports changes', async () => {
  const patches: Record<string, unknown>[] = []
  render(
    <HuddleMemberControls name="Ada" settings={{ volume: 0.5, muted: false }} onChange={(p) => patches.push(p)}>
      <button type="button">Ada</button>
    </HuddleMemberControls>,
  )
  await openMenu()
  const slider = screen.getByLabelText('Volume for Ada') as HTMLInputElement
  assert.equal(slider.value, '0.5')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(slider, '0.2')
    slider.dispatchEvent(new Event('change', { bubbles: true }))
  })
  assert.deepEqual(patches.at(-1), { volume: 0.2 })
  cleanup()
})

test('local mute is offered and labelled as affecting only me', async () => {
  const patches: Record<string, unknown>[] = []
  render(
    <HuddleMemberControls name="Ada" settings={{ volume: 1, muted: false }} onChange={(p) => patches.push(p)}>
      <button type="button">Ada</button>
    </HuddleMemberControls>,
  )
  await openMenu()
  await act(async () => { screen.getByLabelText('Mute Ada for me').click() })
  assert.deepEqual(patches.at(-1), { muted: true })
  assert.ok(screen.getByText(/only affects what you hear/i))
  cleanup()
})

test('a muted member shows the muted icon and a disabled slider', async () => {
  render(
    <HuddleMemberControls name="Ada" settings={{ volume: 0.8, muted: true }} onChange={() => {}}>
      <button type="button">Ada</button>
    </HuddleMemberControls>,
  )
  await openMenu()
  assert.ok(screen.getByLabelText('Unmute Ada for me'))
  assert.equal((screen.getByLabelText('Volume for Ada') as HTMLInputElement).disabled, true)
  cleanup()
})
