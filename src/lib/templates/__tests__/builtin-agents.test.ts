import test from 'node:test'
import assert from 'node:assert/strict'
import { builtInTemplates } from '@/lib/templates/builtin-agents'
import { EXAMPLE_REPORTS } from '@/lib/templates/example-reports'
import { BUILTIN_CONNECTORS, isSelected } from '@/lib/connectors/registry'
import { NANGO_PROVIDERS } from '@/lib/nango/provider-tools'

/**
 * The agent catalogue's contract — the counterpart to the flow catalogue's
 * builtin.test.ts. A built-in that violates any of these ships a broken "Use
 * this agent" to every workspace, so these run on every commit.
 */

type BuiltInAgent = (typeof builtInTemplates)[number] & {
  playbook?: string
  allowSubagents?: boolean
}

const templates = builtInTemplates as readonly BuiltInAgent[]

test('the catalogue is not empty', () => {
  assert.ok(templates.length >= 20, `expected a populated catalogue, got ${templates.length}`)
})

test('every built-in carries the fields the gallery and the runtime require', () => {
  for (const template of templates) {
    for (const field of ['id', 'name', 'icon', 'description', 'category', 'instructions', 'model'] as const) {
      const value = (template as Record<string, unknown>)[field]
      assert.equal(typeof value, 'string', `${template.id}: ${field} must be a string`)
      assert.ok(String(value).trim().length > 0, `${template.id}: ${field} is empty`)
      assert.equal(String(value), String(value).trim(), `${template.id}: ${field} has stray whitespace`)
    }
    assert.ok(Array.isArray(template.integrations), `${template.id}: integrations must be an array`)
    assert.ok(Array.isArray(template.tags), `${template.id}: tags must be an array`)
    assert.ok(template.tags.length > 0, `${template.id}: has no tags, so it never appears under a filter`)
    if ('allowSubagents' in template && template.allowSubagents !== undefined) {
      assert.equal(typeof template.allowSubagents, 'boolean', `${template.id}: allowSubagents must be a boolean`)
    }
  }
})

test('ids are unique and shaped for a stable catalogue slug', () => {
  const ids = templates.map((template) => template.id)
  assert.equal(new Set(ids).size, ids.length, `duplicate template id: ${ids.filter((id, i) => ids.indexOf(id) !== i)}`)
  for (const id of ids) assert.match(id, /^[a-z0-9][a-z0-9-]*$/, `"${id}" is not a slug`)
})

/**
 * Flow templates bind an agent BY NAME (see the flow catalogue's
 * "every agent binding names an agent template a workspace can actually deploy"),
 * so two built-ins sharing a name would make that binding ambiguous.
 */
test('names are unique, since a flow template binds an agent by name', () => {
  const names = templates.map((template) => template.name.trim().toLowerCase())
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index)
  assert.deepEqual(duplicates, [], `duplicate agent names: ${duplicates.join(', ')}`)
})

test('every built-in advertises the example output the gallery renders', () => {
  for (const template of templates) {
    const example = template.exampleOutput
    assert.equal(typeof example, 'string', `${template.id}: exampleOutput must be a string`)
    assert.ok(example.trim().length > 0, `${template.id}: exampleOutput is empty`)
    assert.match(example, /<html|<!doctype/i, `${template.id}: the advertised example is not the house HTML report format`)
    assert.equal(EXAMPLE_REPORTS[template.id as keyof typeof EXAMPLE_REPORTS], example, `${template.id}: exampleOutput is not its own catalogue entry`)
  }
})

test('no example report is orphaned', () => {
  const ids = new Set(templates.map((template) => template.id))
  const orphans = Object.keys(EXAMPLE_REPORTS).filter((key) => !ids.has(key))
  assert.deepEqual(orphans, [], `example reports with no template: ${orphans.join(', ')}`)
})

/**
 * A declared integration is both a "Requires" chip in the gallery AND the
 * selection string the runtime matches when loading tool planes
 * (isSelected for built-ins, `nango:<provider>` for connected providers). A
 * label that matches neither is a requirement the workspace can never satisfy
 * and a tool the agent will never receive.
 */
const KNOWN_UNMATCHED_INTEGRATIONS = new Set(['nango:snowflake', 'CRM', 'Calendar'])

const activatesAPlane = (integration: string) =>
  BUILTIN_CONNECTORS.some((connector) => isSelected(connector, [integration])) ||
  NANGO_PROVIDERS.some((provider) => integration === `nango:${provider}` || integration.toLowerCase() === provider)

test('every declared integration activates a real tool plane', () => {
  const offenders: string[] = []
  for (const template of templates) {
    for (const integration of template.integrations) {
      assert.equal(typeof integration, 'string', `${template.id}: non-string integration`)
      assert.equal(integration, integration.trim(), `${template.id}: "${integration}" has stray whitespace`)
      if (!activatesAPlane(integration) && !KNOWN_UNMATCHED_INTEGRATIONS.has(integration)) {
        offenders.push(`${template.id}: "${integration}"`)
      }
    }
  }
  assert.deepEqual(offenders, [], `integrations that match no connector and no Nango provider:\n${offenders.join('\n')}`)
})

/**
 * Pinned so the known-broken set can only SHRINK. Each of these renders a
 * "Requires" chip the workspace can never turn green, and selects no tool at
 * run time: there is no Snowflake Nango provider, and no connector matches the
 * generic labels "CRM" or "Calendar".
 */
test('the set of integrations that match nothing is exactly the documented backlog', () => {
  const unmatched = new Set<string>()
  for (const template of templates) {
    for (const integration of template.integrations) {
      if (!activatesAPlane(integration)) unmatched.add(integration)
    }
  }
  assert.deepEqual(
    [...unmatched].sort(),
    [...KNOWN_UNMATCHED_INTEGRATIONS].sort(),
    'the unmatched-integration backlog changed — fix the label, or update this pin deliberately',
  )
})

test('instructions never leak raw token syntax to the reader', () => {
  for (const template of templates) {
    for (const [field, value] of [
      ['name', template.name],
      ['description', template.description],
      ['instructions', template.instructions],
    ] as const) {
      assert.equal(value.includes('{{'), false, `${template.id}: ${field} shows raw token syntax`)
    }
  }
})

/**
 * A built-in ships to EVERY workspace, so an instruction naming a specific
 * person's address would point every customer's agent at that inbox.
 */
test('no built-in hardcodes a personal delivery address', () => {
  const offenders: string[] = []
  for (const template of templates) {
    const found = template.instructions.match(/[\w.+-]+@[\w-]+\.[\w.]+/g)
    if (found) offenders.push(`${template.id}: ${found.join(', ')}`)
  }
  assert.deepEqual(offenders, [], `hardcoded recipient in built-in instructions:\n${offenders.join('\n')}`)
})

test('a template that delegates to another agent asks for a name the catalogue has', () => {
  const names = templates.map((template) => template.name)
  for (const template of templates) {
    for (const quoted of template.instructions.match(/"([^"]{3,60})" agent/g) ?? []) {
      const wanted = quoted.replace(/" agent$/, '').replace(/^"/, '')
      assert.ok(
        names.includes(wanted),
        `${template.id}: delegates to "${wanted}", which is not an agent template a workspace can deploy`,
      )
    }
  }
})

test('a template that delegates declares that subagents are allowed', () => {
  for (const template of templates) {
    if (!template.instructions.includes('run_agent')) continue
    assert.equal(template.allowSubagents, true, `${template.id}: calls run_agent but does not allow subagents`)
  }
})

test('every icon is a short emoji glyph, not a word or a URL', () => {
  for (const template of templates) {
    assert.ok(template.icon.length <= 4, `${template.id}: icon "${template.icon}" is not a glyph`)
    assert.equal(/^[a-zA-Z0-9]/.test(template.icon), false, `${template.id}: icon "${template.icon}" is text`)
  }
})

test('categories come from a small, stable vocabulary', () => {
  const categories = new Set(templates.map((template) => template.category))
  assert.deepEqual(
    [...categories].sort(),
    [
      'Account Monitoring',
      'Coaching & Enablement',
      'Customer Success',
      'Daily Intelligence',
      'Pipeline & Forecasting',
      'Platform Enablement',
      'Strategic Intelligence',
    ],
    'the gallery groups by category — a new one changes the browse experience, so pin it deliberately',
  )
})

test('every built-in names a model the runtime can dispatch', () => {
  for (const template of templates) {
    assert.match(template.model, /^[a-z0-9][a-z0-9.-]*$/, `${template.id}: "${template.model}" is not a model id`)
  }
})

test('instructions are substantial enough to steer a run', () => {
  for (const template of templates) {
    assert.ok(template.instructions.length >= 120, `${template.id}: instructions are too thin (${template.instructions.length} chars)`)
  }
})
