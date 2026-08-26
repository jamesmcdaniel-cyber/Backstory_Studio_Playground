import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { QuickConfigChip } from '../tool-quick-config-popover'
import { mcpToolQuickConfig, type ToolScopeOption } from '@/lib/connectors/tool-quick-config'

const config = mcpToolQuickConfig({ id: 'conn-1', name: 'N8N' })

function chip(over: {
  selected?: boolean
  connected?: boolean
  value?: ToolScopeOption[]
  onToggle?: () => void
  onValueChange?: (value: ToolScopeOption[]) => void
} = {}) {
  return render(
    <QuickConfigChip
      label="N8N"
      slug="n8n"
      connected={over.connected ?? true}
      selected={over.selected ?? false}
      config={config}
      value={over.value ?? []}
      onToggle={over.onToggle ?? (() => {})}
      onValueChange={over.onValueChange ?? (() => {})}
    />,
  )
}

test('a connected MCP server offers its tool list before it is attached', (t) => {
  t.after(cleanup)
  chip()
  // Deciding whether to attach a server is a question about what it can do.
  // Gating the list behind attaching meant the only way to find out was to
  // commit first.
  assert.ok(screen.getByTitle(/See this connection’s tools/))
})

test('an unattached chip does not claim the agent has all its tools', (t) => {
  t.after(cleanup)
  chip()
  // "All tools" is a statement about a scope this agent does not have.
  assert.equal(screen.queryByText('All tools'), null)
  assert.ok(screen.getByText('tools'))
})

test('an attached chip reads out the scope it actually grants', (t) => {
  t.after(cleanup)
  chip({ selected: true })
  assert.ok(screen.getByText('All tools'))
})

test('an attached chip with a subset counts it', (t) => {
  t.after(cleanup)
  chip({ selected: true, value: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }] })
  assert.ok(screen.getByText('2 tools'))
})

test('a server that is not connected offers nothing to configure', (t) => {
  t.after(cleanup)
  chip({ connected: false })
  assert.equal(screen.queryByTitle(/tools/), null)
})

/** The tools endpoint, answering with a server's live tool list. */
function stubTools(items: Array<{ name: string }>) {
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ success: true, items }), {
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
  return () => { globalThis.fetch = original }
}

test('an unattached MCP server lists the tools it actually exposes', async (t) => {
  const restore = stubTools([{ name: 'top_records' }, { name: 'find_account' }])
  t.after(() => { restore(); cleanup() })
  chip()

  fireEvent.click(screen.getByTitle(/See this connection’s tools/))
  // The point of the whole change: what this server can do, without attaching
  // it first to find out.
  assert.ok(await screen.findByText('top_records'))
  assert.ok(screen.getByText('find_account'))
  assert.ok(screen.getByText('(2 available)'))
})

test('choosing a tool on an unattached chip attaches the server', async (t) => {
  const restore = stubTools([{ name: 'top_records' }])
  let toggled = 0
  let received: ToolScopeOption[] | null = null
  t.after(() => { restore(); cleanup() })
  chip({
    onToggle: () => { toggled += 1 },
    onValueChange: (value) => { received = value },
  })

  fireEvent.click(screen.getByTitle(/See this connection’s tools/))
  const tool = await screen.findByText('top_records')
  fireEvent.click(tool.closest('label')!.querySelector('input')!)

  // Restricting an agent to a subset of a server it cannot use is not a state
  // worth being able to reach.
  assert.equal(toggled, 1)
  assert.deepEqual(received, [{ id: 'top_records', label: 'top_records' }])
})

test('an already-attached chip is not toggled off by choosing tools', async (t) => {
  const restore = stubTools([{ name: 'top_records' }])
  let toggled = 0
  t.after(() => { restore(); cleanup() })
  chip({ selected: true, onToggle: () => { toggled += 1 } })

  fireEvent.click(screen.getByTitle(/Choose tools/))
  const tool = await screen.findByText('top_records')
  fireEvent.click(tool.closest('label')!.querySelector('input')!)
  assert.equal(toggled, 0)
})
