import '@/test-support/jsdom-env'
import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, act } from '@testing-library/react'
import { StatefulArtifactFrame } from '../stateful-artifact-frame'

test('state bridge binds the exact opaque frame and trusted artifact/version, never message targets', async () => {
  const original = globalThis.fetch
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return Response.json({ revision: 1 }) }
  try {
    const ui = render(<StatefulArtifactFrame artifactId="trusted-artifact" versionId="trusted-version" title="Fixture" writable />)
    const frame = ui.getByTitle('Fixture') as HTMLIFrameElement
    const data = { type: 'backstory:state', id: '1', op: 'set', payload: { key: 'records-v1', value: [7], revision: 0, artifactId: 'foreign', versionId: 'foreign', url: 'https://evil.example' } }
    const send = async (source: Window | null, origin: string) => { await act(async () => { window.dispatchEvent(new window.MessageEvent('message', { source, origin, data })) }) }
    await send(window, 'null')
    await send(frame.contentWindow, 'https://evil.example')
    assert.equal(calls.length, 0)
    const acks: unknown[] = []
    const post = frame.contentWindow!.postMessage.bind(frame.contentWindow)
    frame.contentWindow!.postMessage = ((message: any, ...rest: any[]) => { if (message?.type === 'backstory:state-ack') acks.push(message); return (post as any)(message, ...rest) }) as typeof post
    await send(frame.contentWindow, 'null')
    assert.equal(calls.length, 1)
    assert.deepEqual(acks, [{ type: 'backstory:state-ack', id: '1' }], 'the bridge says it is there before its fetch, so a slow load is not "no bridge"')
    assert.equal(calls[0].url, '/api/artifacts/trusted-artifact/state')
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { key: 'records-v1', value: [7], revision: 0, versionId: 'trusted-version' })
    assert.doesNotMatch(frame.getAttribute('sandbox') ?? '', /allow-same-origin/)
    ui.rerender(<StatefulArtifactFrame artifactId="trusted-artifact" versionId="trusted-version" title="Fixture" writable={false} />)
    await send(frame.contentWindow, 'null')
    assert.equal(calls.length, 1, 'read-only/history frame never reaches authenticated state API')
  } finally { cleanup(); globalThis.fetch = original }
})

test('external versions wait for unsaved edits, then switch after successful save', async () => {
  try {
    const ui = render(<StatefulArtifactFrame artifactId="fixture" versionId="v1" title="Live fixture" writable />)
    const frame = ui.getByTitle('Live fixture') as HTMLIFrameElement
    await act(async () => { window.dispatchEvent(new window.MessageEvent('message', { source: frame.contentWindow, origin: 'null', data: { type: 'backstory:dirty', dirty: true } })) })
    ui.rerender(<StatefulArtifactFrame artifactId="fixture" versionId="v2" title="Live fixture" writable />)
    assert.match(frame.src, /v1\/content$/)
    assert.ok(ui.getByText(/Your unsaved work is still open/))
    await act(async () => { window.dispatchEvent(new window.MessageEvent('message', { source: frame.contentWindow, origin: 'null', data: { type: 'backstory:dirty', dirty: false } })) })
    assert.match((ui.getByTitle('Live fixture') as HTMLIFrameElement).src, /v2\/content$/)
  } finally { cleanup() }
})

test('shared state: a frame\'s shared write goes to the shared route and its result comes back; watch requests need no network', async () => {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = async (url) => { calls.push(String(url)); return Response.json({ success: true, revision: 4 }) }
  try {
    const ui = render(<StatefulArtifactFrame artifactId="live-artifact" versionId="v1" title="Shared fixture" writable />)
    const frame = ui.getByTitle('Shared fixture') as HTMLIFrameElement
    const results: any[] = []
    frame.contentWindow!.postMessage = ((message: any) => { if (message?.type === 'backstory:state-result') results.push(message) }) as Window['postMessage']
    const send = async (data: unknown) => { await act(async () => { window.dispatchEvent(new window.MessageEvent('message', { source: frame.contentWindow, origin: 'null', data })) }) }
    await send({ type: 'backstory:shared-watch', key: 'votes-v1' })
    await send({ type: 'backstory:shared-watch', key: 'bad key!' })
    assert.equal(calls.length, 0, 'following a key opens a subscription, not a request')
    await send({ type: 'backstory:state', id: '9', op: 'set', payload: { key: 'votes-v1', value: { yes: 1 }, revision: 3, shared: true } })
    assert.deepEqual(calls, ['/api/artifacts/live-artifact/shared-state'])
    assert.equal(results[0]?.result?.revision, 4)
  } finally { cleanup(); globalThis.fetch = original }
})
