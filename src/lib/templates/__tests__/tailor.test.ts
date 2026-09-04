import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyEdits, diffTemplate, hasEdits, sameTools, tailorProblem } from '../tailor'

const TEMPLATE = {
  id: '01-sales-digest',
  name: 'Sales digest',
  instructions: 'Summarise yesterday.',
  integrations: ['Slack', 'nango:salesforce'],
}

test('an untouched draft produces no edits', () => {
  const edits = diffTemplate(TEMPLATE, { instructions: TEMPLATE.instructions, integrations: [...TEMPLATE.integrations] })
  assert.deepEqual(edits, {})
  assert.equal(hasEdits(edits), false)
})

test('reordering the tools is not an edit', () => {
  const edits = diffTemplate(TEMPLATE, {
    instructions: TEMPLATE.instructions,
    integrations: ['nango:salesforce', 'Slack'],
  })
  assert.deepEqual(edits, {})
})

test('tool keys compare case-insensitively, as the available-tools list dedupes them', () => {
  assert.equal(sameTools(['Slack'], ['slack']), true)
  assert.equal(sameTools(['Slack'], ['Slack', 'Email']), false)
  assert.equal(sameTools([], []), true)
})

test('a repeated tool does not make two lists differ in size', () => {
  assert.equal(sameTools(['Slack', 'slack'], ['Slack']), true)
})

test('trailing whitespace in the textarea is not an instructions edit', () => {
  const edits = diffTemplate(TEMPLATE, {
    instructions: `${TEMPLATE.instructions}\n\n`,
    integrations: [...TEMPLATE.integrations],
  })
  assert.equal(edits.instructions, undefined)
})

test('a real rewrite is recorded exactly as typed', () => {
  const rewritten = 'Summarise yesterday.\n\n  Then post it.'
  const edits = diffTemplate(TEMPLATE, { instructions: rewritten, integrations: [...TEMPLATE.integrations] })
  assert.equal(edits.instructions, rewritten)
  assert.equal(hasEdits(edits), true)
})

test('swapping a tool records only the tools, leaving instructions as shipped', () => {
  const edits = diffTemplate(TEMPLATE, {
    instructions: TEMPLATE.instructions,
    integrations: ['Slack', 'nango:hubspot'],
  })
  assert.deepEqual(edits, { integrations: ['Slack', 'nango:hubspot'] })
})

test('removing every tool is an edit, not an absence of one', () => {
  const edits = diffTemplate(TEMPLATE, { instructions: TEMPLATE.instructions, integrations: [] })
  assert.deepEqual(edits, { integrations: [] })
  assert.equal(hasEdits(edits), true)
})

test('applying edits keeps every field the tailoring UI never touches', () => {
  const tailored = applyEdits(TEMPLATE, { integrations: ['Email'] })
  assert.equal(tailored.id, '01-sales-digest')
  assert.equal(tailored.name, 'Sales digest')
  assert.equal(tailored.instructions, 'Summarise yesterday.')
  assert.deepEqual(tailored.integrations, ['Email'])
})

test('applying no edits returns the template unchanged in value', () => {
  assert.deepEqual(applyEdits(TEMPLATE, {}), TEMPLATE)
})

test('the recorded tool list is a copy, so later picker clicks cannot mutate it', () => {
  const draftTools = ['Email']
  const edits = diffTemplate(TEMPLATE, { instructions: TEMPLATE.instructions, integrations: draftTools })
  draftTools.push('Slack')
  assert.deepEqual(edits.integrations, ['Email'])
})

test('blank instructions are refused; no tools at all are fine', () => {
  assert.match(tailorProblem({ instructions: '   \n', integrations: ['Slack'] }) ?? '', /cannot be empty/)
  assert.equal(tailorProblem({ instructions: 'Do the thing.', integrations: [] }), null)
})
