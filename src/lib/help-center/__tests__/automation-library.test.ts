import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { distillSkill, distillWorkflow, rankLibrary, type LibraryEntry } from '@/lib/help-center/automation-library'
import { questionTerms } from '@/lib/help-center/fetching'

// Field-for-field the shape the live /workflows.json serves, trailing table
// pipe in `trigger` included.
const WORKFLOW = {
  id: '01-sales-digest',
  name: 'Sales Digest',
  description: 'Generates a personalized daily sales digest for each enrolled user.',
  category: 'daily-intelligence',
  trigger: 'Schedule — 6:00 AM weekdays                        |',
  output: 'Messaging (Slack channel, Teams channel, or Email)',
  credentials: ['Backstory MCP — Account activity and engagement data', 'LLM API'],
  node_flow: [
    { step: 1, name: 'Schedule Trigger', description: 'Fires at 6:00 AM on weekdays.', type: 'trigger' },
    { step: 2, name: 'Fetch Digest Users', description: 'Reads the subscriber list.', type: 'data' },
  ],
}

const SKILL = {
  id: '01-account-plan-agent',
  number: '01',
  name: 'Account Plan Agent',
  category: 'account-research',
  description: 'Transforms static account plans into dynamic, interactive dashboards.',
  audience: ['AEs', 'CSMs'],
  input: 'Account name',
  mcpTools: ['find_account', 'get_account_status'],
  platforms: { 'claude-project': {}, 'claude-code': {} },
  walkthrough: { steps: [{ type: 'tool', name: 'find_account', description: 'Find the Account', stepNum: 1 }] },
}

describe('distillWorkflow', () => {
  const entry = distillWorkflow(WORKFLOW)

  it('summarises the workflow as something a reader could go and run', () => {
    assert.ok(entry)
    assert.equal(entry.kind, 'workflow')
    assert.ok(entry.text.includes('Sales Digest — automation workflow (daily-intelligence)'))
    assert.ok(entry.text.includes('Delivers to: Messaging'))
    assert.ok(entry.text.includes('Needs: Backstory MCP'))
    assert.ok(entry.text.includes('1. Schedule Trigger — Fires at 6:00 AM on weekdays.'))
  })

  it('trims the table pipes the catalogue leaves on trigger strings', () => {
    assert.ok(entry?.text.includes('Trigger: Schedule — 6:00 AM weekdays\n'))
    assert.ok(!entry?.text.includes('|'))
  })

  it('drops an entry with nothing to identify it rather than citing a blank', () => {
    assert.equal(distillWorkflow({ description: 'orphan' }), null)
  })

  it('skips fields the catalogue omits instead of inventing them', () => {
    const sparse = distillWorkflow({ id: 'x', name: 'Bare' })
    assert.equal(sparse?.text, 'Bare — automation workflow')
  })
})

describe('distillSkill', () => {
  const entry = distillSkill(SKILL)

  it('keeps the parts that make a skill actionable — input, tools, platforms', () => {
    assert.ok(entry)
    assert.equal(entry.kind, 'skill')
    assert.ok(entry.text.includes('Account Plan Agent — LLM skill (account-research)'))
    assert.ok(entry.text.includes('Input: Account name'))
    assert.ok(entry.text.includes('Built for: AEs, CSMs'))
    assert.ok(entry.text.includes('Backstory MCP tools it calls: find_account, get_account_status'))
    assert.ok(entry.text.includes('Runs on: claude-project, claude-code'))
    assert.ok(entry.text.includes('1. find_account — Find the Account'))
  })

  it('survives a walkthrough the catalogue has not filled in', () => {
    const entry = distillSkill({ ...SKILL, walkthrough: null, mcpTools: null })
    assert.ok(entry?.text.includes('Account Plan Agent'))
    assert.ok(!entry?.text.includes('How it runs'))
  })
})

describe('rankLibrary', () => {
  const catalogue = [distillWorkflow(WORKFLOW), distillSkill(SKILL)].filter((e): e is LibraryEntry => e !== null)

  it('ranks the entry whose name carries the question first', () => {
    const ranked = rankLibrary(questionTerms('is there a sales digest workflow?'), catalogue)
    assert.equal(ranked[0]?.name, 'Sales Digest')
  })

  it('finds an entry through what it is built on, not just its name', () => {
    const ranked = rankLibrary(questionTerms('which agents call the Backstory MCP account tools?'), catalogue)
    assert.ok(ranked.some((e) => e.name === 'Account Plan Agent'))
  })

  it('ranks nothing for a question the catalogue does not cover', () => {
    assert.deepEqual(rankLibrary(questionTerms('what is the weather in Tokyo'), catalogue), [])
  })

  it('ranks nothing for a question with no matchable words', () => {
    assert.deepEqual(rankLibrary(questionTerms('how do you do that?'), catalogue), [])
  })

  it('honours the depth limit', () => {
    assert.equal(rankLibrary(questionTerms('backstory account'), catalogue, 1).length, 1)
  })
})
