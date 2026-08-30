import test from 'node:test'
import assert from 'node:assert/strict'
import { flowGraphSchema } from '@/lib/flows/graph'
import { validateFlowGraph } from '@/lib/flows/validate'
import { BUILTIN_FLOW_TEMPLATES } from '@/lib/flows/templates/builtin'
import { BUILTIN_CONNECTORS } from '@/lib/connectors/registry'
import { NANGO_PROVIDERS, NANGO_PROVIDER_TOOLS } from '@/lib/nango/provider-tools'
import { DELIVERY_TOOLS } from '@/lib/nango/delivery'
import { slackTools } from '@/lib/integrations/slack'
import { emailTools } from '@/lib/integrations/email'
import { httpTools } from '@/lib/integrations/http'
import { flowTemplateNotesIssues, flowTemplateNotesSchema, flowTemplateBindingSchema } from '@/lib/flows/templates/types'

/**
 * The catalogue's contract. A built-in that violates any of these ships a
 * broken "Use this flow" to every workspace, so these run on every commit.
 */

test('every built-in graph parses the flow graph schema', () => {
  for (const template of BUILTIN_FLOW_TEMPLATES) {
    assert.doesNotThrow(() => flowGraphSchema.parse(template.graph), `${template.id} graph does not parse`)
  }
})

test('built-in ids and node ids are unique', () => {
  const ids = BUILTIN_FLOW_TEMPLATES.map((template) => template.id)
  assert.equal(new Set(ids).size, ids.length, 'duplicate template id')
  for (const template of BUILTIN_FLOW_TEMPLATES) {
    const nodeIds = template.graph.nodes.map((node) => node.id)
    assert.equal(new Set(nodeIds).size, nodeIds.length, `${template.id} has duplicate node ids`)
  }
})

test('built-in notes and bindings parse their schemas', () => {
  for (const template of BUILTIN_FLOW_TEMPLATES) {
    assert.doesNotThrow(() => flowTemplateNotesSchema.parse(template.notes), `${template.id} notes do not parse`)
    assert.doesNotThrow(() => flowTemplateBindingSchema.array().parse(template.bindings), `${template.id} bindings do not parse`)
  }
})

test('every executable step is explained, on the canvas and in the notes', () => {
  for (const template of BUILTIN_FLOW_TEMPLATES) {
    const issues = flowTemplateNotesIssues(template.graph, template.notes, template.bindings)
    assert.deepEqual(issues, [], `${template.id}: ${issues.join(' | ')}`)
  }
})

test('notes never leak raw token syntax to the reader', () => {
  for (const template of BUILTIN_FLOW_TEMPLATES) {
    for (const field of [template.name, template.description, ...template.bindings.map((b) => b.label)]) {
      assert.ok(!field.includes('{{'), `${template.id} shows token syntax in "${field}"`)
    }
  }
})

/**
 * A portable template ships agent/connection slots empty on purpose, so the
 * only validation errors allowed are the ones that name a step with a declared
 * binding. Anything else is a genuine authoring bug.
 */
test('built-ins validate cleanly apart from their declared, unfilled slots', () => {
  for (const template of BUILTIN_FLOW_TEMPLATES) {
    const boundNodes = new Set(template.bindings.map((binding) => binding.nodeId))
    const unexpected = validateFlowGraph(template.graph, { requireRunnable: true }).errors.filter(
      // HTTP_NO_AUTH is an expected authoring-time gap, not a template bug:
      // templates can't ship credentials, and every HTTP step must be
      // authenticated by the user before the flow runs.
      (error) => (!error.nodeId || !boundNodes.has(error.nodeId)) && error.code !== 'HTTP_NO_AUTH',
    )
    assert.deepEqual(
      unexpected.map((error) => `${error.nodeId ?? 'flow'}: ${error.message}`),
      [],
      `${template.id} has validation errors that no binding explains`,
    )
  }
})

test('every empty agent or connection slot has a binding that fills it', () => {
  for (const template of BUILTIN_FLOW_TEMPLATES) {
    const bound = new Set(template.bindings.map((binding) => binding.nodeId))
    for (const node of template.graph.nodes) {
      if (node.type === 'agent' && !node.data.agentId) {
        assert.ok(bound.has(node.id), `${template.id}: agent step "${node.id}" is empty with no binding`)
      }
      if (node.type === 'tool' && !node.data.connectionId) {
        assert.ok(bound.has(node.id), `${template.id}: tool step "${node.id}" is empty with no binding`)
      }
    }
  }
})

/**
 * An agent binding resolves by NAME against the workspace roster, so a template
 * that names an agent nobody can have — a typo, or a name the agent gallery
 * never shipped — instantiates with a permanently empty step and no way for the
 * user to know why. Pinning the names to the agent catalogue makes that a
 * build-time failure instead.
 */
test('every agent binding names an agent template a workspace can actually deploy', async () => {
  const { builtInTemplates } = await import('@/lib/templates/builtin-agents')
  const agentNames = new Set(builtInTemplates.map((template) => template.name.trim().toLowerCase()))
  for (const template of BUILTIN_FLOW_TEMPLATES) {
    for (const binding of template.bindings) {
      if (binding.kind !== 'agent') continue
      const wanted = binding.match.agentName?.trim().toLowerCase()
      assert.ok(wanted, `${template.id}: agent binding "${binding.label}" names no agent`)
      assert.ok(
        agentNames.has(wanted),
        `${template.id}: agent binding wants "${binding.match.agentName}", which is not an agent template a workspace can deploy`,
      )
    }
  }
})

/**
 * `integrations` drives the "Requires" chips and the missing-integration setup
 * items, which match a connected provider key case-insensitively — so a display
 * name like "Backstory MCP" would read as permanently unconnected.
 */
test('declared integrations use connector keys the workspace can match', () => {
  // Built-in planes plus the Nango provider keys — both are what
  // summarizeConnectedIntegrations reports as a connected provider's key
  // (fromNangoProviderKey normalizes config keys to exactly these), so either
  // kind matches the "Requires" chips and the missing-integration setup items.
  const known = new Set([
    ...BUILTIN_CONNECTORS.map((connector) => connector.key.toLowerCase()),
    ...NANGO_PROVIDERS.map((provider) => provider.toLowerCase()),
  ])
  for (const template of BUILTIN_FLOW_TEMPLATES) {
    for (const integration of template.integrations) {
      assert.ok(
        known.has(integration.trim().toLowerCase()),
        `${template.id}: "${integration}" is not a connector key (expected one of ${[...known].join(', ')})`,
      )
    }
  }
})

test('a template that calls a connection or an agent declares what it needs', () => {
  for (const template of BUILTIN_FLOW_TEMPLATES) {
    const connectionBindings = template.bindings.filter((binding) => binding.kind === 'connection')
    for (const binding of connectionBindings) {
      const provider = binding.match.provider?.trim().toLowerCase()
      assert.ok(provider, `${template.id}: connection binding "${binding.label}" names no provider`)
      assert.ok(
        template.integrations.some((entry) => entry.trim().toLowerCase() === provider),
        `${template.id}: binds the "${binding.match.provider}" connection but does not list it in integrations, so its card shows no requirement`,
      )
    }
  }
})

const BACKSTORY_TEMPLATE_TOOLS = new Set([
  'top_records',
  'find_account',
  'get_account_status',
  'ask_sales_ai_about_account',
])

test('every connection binding names a tool the selected runtime plane actually exposes', () => {
  const native = new Map([
    ['slack', new Set(slackTools().map((tool) => tool.name))],
    ['email', new Set(emailTools().map((tool) => tool.name))],
    ['http api', new Set(httpTools().map((tool) => tool.name))],
  ])
  for (const template of BUILTIN_FLOW_TEMPLATES) {
    for (const binding of template.bindings) {
      if (binding.kind !== 'connection') continue
      const provider = binding.match.provider?.trim().toLowerCase().replace(/^nango:/, '') ?? ''
      const toolName = binding.match.toolName?.trim() ?? ''
      assert.ok(toolName, `${template.id}: ${binding.nodeId} has no tool name in its binding`)
      const available = new Set([
        ...(native.get(provider) ?? []),
        ...NANGO_PROVIDER_TOOLS.filter((tool) => tool.provider === provider).map((tool) => tool.name),
        ...DELIVERY_TOOLS.filter((tool) => tool.capability === provider).map((tool) => tool.name),
        ...(provider === 'backstory' ? BACKSTORY_TEMPLATE_TOOLS : []),
      ])
      assert.ok(
        available.has(toolName),
        `${template.id}: ${binding.nodeId} binds ${binding.match.provider}.${toolName}, but that runtime plane does not expose it`,
      )
    }
  }
})

test('workspace-specific required values are declared as blocking setup, never hidden gaps', () => {
  const requiredByTool = new Map<string, string[]>()
  for (const tool of [...NANGO_PROVIDER_TOOLS, ...DELIVERY_TOOLS, ...slackTools(), ...emailTools(), ...httpTools()]) {
    const schema = tool.inputSchema as { required?: unknown }
    if (Array.isArray(schema.required)) requiredByTool.set(tool.name, schema.required.filter((entry): entry is string => typeof entry === 'string'))
  }
  for (const template of BUILTIN_FLOW_TEMPLATES) {
    const declared = new Set(template.notes.setup.filter((step) => step.kind === 'value').map((step) => step.ref))
    for (const node of template.graph.nodes) {
      if (node.type !== 'tool') continue
      const required = requiredByTool.get(node.data.toolName) ?? []
      const args = JSON.parse(node.data.args || '{}') as Record<string, unknown>
      const missing = required.filter((name) => args[name] === '' || args[name] == null)
      if (missing.length) {
        assert.ok(
          declared.has(node.id),
          `${template.id}: ${node.id} is missing ${missing.join(', ')} with no value-setup item`,
        )
      }
    }
  }
})

test('built-ins use credential-aware tools rather than unauthenticated raw HTTP nodes', () => {
  for (const template of BUILTIN_FLOW_TEMPLATES) {
    assert.deepEqual(
      template.graph.nodes.filter((node) => node.type === 'http').map((node) => node.id),
      [],
      `${template.id}: raw HTTP cannot be one-click credential-bound; use the HTTP API tool plane`,
    )
  }
})

test('flagship details are backed by their executable graph', () => {
  const byId = new Map(BUILTIN_FLOW_TEMPLATES.map((template) => [template.id, template]))

  const renewal = byId.get('renewal-brief')!
  const renewalRead = renewal.graph.nodes.find((node) => node.id === 'fetch')
  assert.equal(renewalRead?.type === 'tool' && renewalRead.data.toolName, 'salesforce_query')
  assert.match(renewalRead?.type === 'tool' ? (renewalRead.data.args ?? '') : '', /NEXT_N_DAYS:60/)

  const churn = byId.get('churn-risk-scorecard')!
  const rank = churn.graph.nodes.find((node) => node.id === 'rank')
  assert.match(rank?.type === 'code' ? rank.data.code : '', /account: row\.account/, 'ranked churn rows must keep the account identity')

  const accountPlan = byId.get('account-plan')!
  const found = accountPlan.graph.nodes.find((node) => node.id === 'found')
  assert.equal(found?.type, 'condition', 'an unresolved account must be guarded before enrichment')
  assert.ok(accountPlan.graph.edges.some((edge) => edge.source === 'found' && edge.branch === 'false' && edge.target === 'not-found'))

  const sync = byId.get('nightly-sync')!
  assert.equal(sync.description.includes('publish downstream'), false, 'the details must not promise a downstream write the graph does not execute')
})

/**
 * The Flows page's "Start from a template" strip is the first six of this list
 * (served via ?builtin=1&limit=6), so the catalogue's opening order IS that
 * strip. Pinned so a reorder can't silently swap the flagship pipelines out.
 */
test('the catalogue opens with the six templates the Flows-page strip shows', () => {
  assert.deepEqual(
    BUILTIN_FLOW_TEMPLATES.slice(0, 6).map((template) => template.id),
    ['pipeline-digest', 'upsell-motion', 'account-plan', 'churn-risk-scorecard', 'renewal-brief', 'webhook-triage'],
  )
})

test('starter templates need no setup at all', () => {
  for (const id of ['summarize-extract', 'score-each-item', 'scheduled-wait']) {
    const template = BUILTIN_FLOW_TEMPLATES.find((entry) => entry.id === id)
    assert.ok(template, `${id} is missing from the catalogue`)
    assert.deepEqual(template.bindings, [], `${id} should instantiate with no bindings to resolve`)
  }
})
