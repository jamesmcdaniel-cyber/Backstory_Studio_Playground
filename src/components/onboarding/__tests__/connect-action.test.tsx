import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { ConnectAction } from '../connect-action'
import { EMBED_CONNECT_DONE_MESSAGE } from '@/lib/embed'

const HREF = '/api/mcp-connections/oauth/start?connectionId=c1&returnTo=%2Fauth%2Fembedded-complete'

type OpenCall = { url: string; name: string }

function stubWindowOpen(result: Window | null): OpenCall[] {
  const calls: OpenCall[] = []
  ;(window as unknown as Record<string, unknown>).open = (url: string, name: string) => {
    calls.push({ url, name })
    return result
  }
  return calls
}

const fakePopup = {} as Window

function renderAction(props: Partial<React.ComponentProps<typeof ConnectAction>> = {}) {
  return render(
    React.createElement(ConnectAction, {
      href: HREF,
      label: 'Connect Backstory MCP',
      popupName: 'backstory-connect-mcp',
      embedded: false,
      check: async () => false,
      ...props,
    }),
  )
}

test('top-level, the step is still a plain link the browser follows', () => {
  const opens = stubWindowOpen(fakePopup)
  const { container } = renderAction()
  const link = container.querySelector('a')
  assert.ok(link)
  assert.equal(link?.getAttribute('href'), HREF)
  assert.equal(opens.length, 0)
  cleanup()
})

test('inside a frame the step never navigates the frame — it opens the flow in a popup', () => {
  // The regression: as a link, this navigated the FRAME to the identity
  // provider, which refuses to render framed and whose callback finds no
  // SameSite=Lax state cookie — dumping the user back on step 1 of setup.
  const opens = stubWindowOpen(fakePopup)
  const { container, getByRole } = renderAction({ embedded: true })
  assert.equal(container.querySelector('a'), null)

  fireEvent.click(getByRole('button', { name: /Connect Backstory MCP/ }))
  assert.deepEqual(opens, [{ url: HREF, name: 'backstory-connect-mcp' }])
  cleanup()
})

test('the frame waits for the SERVER to confirm the step, not for the popup to claim it', async () => {
  stubWindowOpen(fakePopup)
  let connected = false
  const { getByRole, findByText } = renderAction({ embedded: true, check: async () => connected })

  fireEvent.click(getByRole('button', { name: /Connect Backstory MCP/ }))
  await findByText(/Waiting for the connection/)

  // The popup's "I'm done" message alone must not end the wait: the server
  // still says no, so the frame keeps waiting rather than showing a success
  // the user does not have.
  const stillUnconfirmed = new window.MessageEvent('message', {
    data: EMBED_CONNECT_DONE_MESSAGE,
    origin: window.location.origin,
  })
  fireEvent(window, stillUnconfirmed)
  await waitFor(() => assert.ok(getByRole('button', { name: /Waiting for the connection/ })))

  connected = true
  fireEvent(
    window,
    new window.MessageEvent('message', { data: EMBED_CONNECT_DONE_MESSAGE, origin: window.location.origin }),
  )
  await waitFor(() => assert.ok(getByRole('button', { name: /Connect Backstory MCP/ })))
  cleanup()
})

test('a message from another origin is ignored', async () => {
  stubWindowOpen(fakePopup)
  let checks = 0
  const { getByRole, findByText } = renderAction({
    embedded: true,
    check: async () => {
      checks += 1
      return true
    },
  })
  fireEvent.click(getByRole('button', { name: /Connect Backstory MCP/ }))
  await findByText(/Waiting for the connection/)

  fireEvent(
    window,
    new window.MessageEvent('message', {
      data: EMBED_CONNECT_DONE_MESSAGE,
      origin: 'https://attacker.example',
    }),
  )
  await waitFor(() => assert.ok(getByRole('button', { name: /Waiting for the connection/ })))
  assert.equal(checks, 0)
  cleanup()
})

test('a blocked popup says so instead of spinning forever', async () => {
  stubWindowOpen(null)
  const { getByRole, findByRole } = renderAction({ embedded: true })
  fireEvent.click(getByRole('button', { name: /Connect Backstory MCP/ }))
  const alert = await findByRole('alert')
  assert.match(alert.textContent ?? '', /Allow pop-ups/)
  assert.ok(getByRole('button', { name: /Connect Backstory MCP/ }))
  cleanup()
})
