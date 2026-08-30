import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  generateTemplateProposals,
  normalizeProposal,
  dedupeProposals,
  intentKey,
  normalizeTitle,
  tolerantObject,
  parseProposalsReply,
  usageSignals,
  runsAnalyzedLine,
  MAX_PROPOSALS,
  PROPOSAL_SCHEMA,
  type RawProposal,
  type GenerateDeps,
  type NormalizeContext,
} from '../generate-proposals'
import { MAX_AUDIT_ROWS, type UsageProfile } from '../usage-profile'
import { GUARDRAIL_RULE } from '@/lib/security/guardrails'
import { UNTRUSTED_DATA_RULE } from '@/lib/security/prompt'
import type { ProposalInput } from '../proposals'

// --- Fixtures ---------------------------------------------------------------

const profile: UsageProfile = {
  providers: [
    { provider: 'slack', calls: 12 },
    { provider: 'people.ai', calls: 9 },
    { provider: 'salesforce', calls: 4 },
  ],
  topTools: [{ provider: 'slack', tool: 'send', calls: 6 }],
  coOccurrence: [{ providers: ['people.ai', 'slack'], runs: 5 }],
  sequences: [{ steps: ['people.ai', 'slack'], count: 4 }],
  runCount: 20,
  windowDays: 90,
  capabilities: [{ provider: 'slack', capabilities: ['send', 'list_channels'] }],
  themes: ['deal.risk_detected', 'forecast.updated'],
  sampled: false,
}

const rawTemplate = (over: Partial<RawProposal> = {}): RawProposal => ({
  kind: 'agent_template',
  title: 'Deal-risk Slack digest',
  category: 'Sales',
  instructions: 'Every morning, gather at-risk deals from Salesforce and post a summary to Slack.',
  integrations: ['slack', 'salesforce'],
  schedule: 'daily',
  exampleOutput: '3 deals at risk this week: ...',
  rationale: 'people.ai and slack are used together in 5 runs',
  confidence: 0.9,
  targetType: '',
  targetId: '',
  configJson: '',
  sourceEvidenceJson: '{"providers":["people.ai","slack"],"reason":"co-occurrence"}',
  ...over,
})

const reply = (proposals: RawProposal[]): string => JSON.stringify({ proposals })

// A deps bundle whose reads are all empty and whose generate is a spy.
function stubDeps(over: Partial<GenerateDeps> & { generate?: GenerateDeps['generate'] } = {}): {
  deps: GenerateDeps
  calls: { generate: number; written: ProposalInput[][] }
} {
  const calls = { generate: 0, written: [] as ProposalInput[][] }
  const deps: GenerateDeps = {
    countConnected: async () => 5,
    buildProfile: async () => profile,
    retrieve: async () => ({ hits: [], related: [] }),
    readCatalogueTitles: async () => [],
    readPriorTitles: async () => [],
    readTargets: async () => ({ flows: [], agents: [] }),
    generate: async () => {
      calls.generate += 1
      return reply([rawTemplate()])
    },
    write: async (_org, rows) => {
      calls.written.push(rows)
      return rows.length
    },
    ...over,
  }
  // wrap the provided generate to still count calls
  if (over.generate) {
    const provided = over.generate
    deps.generate = async (opts) => {
      calls.generate += 1
      return provided(opts)
    }
  }
  return { deps, calls }
}

// --- Gate: below threshold short-circuits BEFORE the model call --------------

test('gate: below the integration threshold returns skipped:gate and never calls generate', async () => {
  const { deps, calls } = stubDeps({ countConnected: async () => 2 })
  const result = await generateTemplateProposals('org-1', deps)
  assert.deepEqual(result, { written: 0, skipped: 'gate' })
  assert.equal(calls.generate, 0, 'the model must NOT be called below the gate')
})

test('gate: exactly at the threshold proceeds to generation', async () => {
  const { deps, calls } = stubDeps({ countConnected: async () => 3 })
  const result = await generateTemplateProposals('org-1', deps)
  assert.equal(result.skipped, null)
  assert.equal(calls.generate, 1)
})

// --- Happy path: schema-valid proposals are written --------------------------

test('generation: schema-valid proposals are written as rows', async () => {
  const { deps, calls } = stubDeps()
  const result = await generateTemplateProposals('org-1', deps)
  assert.equal(result.skipped, null)
  assert.equal(result.written, 1)
  assert.equal(calls.written.length, 1)
  const [rows] = calls.written
  assert.equal(rows[0].title, 'Deal-risk Slack digest')
  assert.equal(rows[0].kind, 'agent_template')
  assert.equal(rows[0].userId, null, 'proposals are org-wide')
  const config = rows[0].configuration as Record<string, unknown>
  assert.deepEqual(config.integrations, ['slack', 'salesforce'])
  assert.equal(config.schedule, 'daily')
  assert.match(config.instructions as string, /Automation asset quality contract/)
  assert.match(config.instructions as string, /Canonical workflow JSON/)
})

// --- sourceEvidence carries the usage signals --------------------------------

test('sourceEvidence: every row carries the server-computed usage signals', async () => {
  const { deps, calls } = stubDeps()
  await generateTemplateProposals('org-1', deps)
  const evidence = calls.written[0][0].sourceEvidence as Record<string, unknown>
  const usage = evidence.usage as Record<string, unknown>
  assert.ok(usage, 'usage signals must be attached')
  assert.deepEqual(usage.providers, ['slack', 'people.ai', 'salesforce'])
  assert.equal(usage.runCount, 20)
  assert.deepEqual(usage.themes, ['deal.risk_detected', 'forecast.updated'])
  // model-supplied evidence is preserved alongside the server signals
  assert.equal((evidence.reason as string), 'co-occurrence')
})

// --- Dedupe against catalogue AND open proposals -----------------------------

test('dedupe: drops a proposal matching an existing catalogue title', async () => {
  const { deps, calls } = stubDeps({
    readCatalogueTitles: async () => ['Deal-Risk Slack Digest'], // same intent, different case
    generate: async () => reply([rawTemplate(), rawTemplate({ title: 'Pipeline forecast recap', category: 'Sales' })]),
  })
  const result = await generateTemplateProposals('org-1', deps)
  assert.equal(result.written, 1, 'the catalogue-duplicate is dropped, the novel one kept')
  assert.equal(calls.written[0][0].title, 'Pipeline forecast recap')
})

test('dedupe: drops a proposal matching a prior (open/dismissed/accepted) proposal title', async () => {
  const { deps } = stubDeps({
    readPriorTitles: async () => ['deal-risk slack digest'],
    generate: async () => reply([rawTemplate()]),
  })
  const result = await generateTemplateProposals('org-1', deps)
  assert.equal(result.written, 0, 'the prior-proposal duplicate is dropped (incl. dismissed)')
})

test('confidence floor: a proposal below CONFIDENCE_FLOOR is dropped', async () => {
  const { deps } = stubDeps({
    generate: async () => reply([rawTemplate({ confidence: 0.4 }), rawTemplate({ title: 'Strong pipeline recap', confidence: 0.8 })]),
  })
  const result = await generateTemplateProposals('org-1', deps)
  assert.equal(result.written, 1, 'only the confident proposal survives')
})

test('usage floor: below MIN_RUNS_FOR_TEMPLATES runs returns skipped:usage and never calls generate', async () => {
  const thin: UsageProfile = { ...profile, runCount: 1 }
  const { deps, calls } = stubDeps({ buildProfile: async () => thin })
  const result = await generateTemplateProposals('org-1', deps)
  assert.deepEqual(result, { written: 0, skipped: 'usage' })
  assert.equal(calls.generate, 0, 'the model must NOT be called before usage is learned')
})

// --- Batch cap ---------------------------------------------------------------

test('batch cap: never writes more than MAX_PROPOSALS', async () => {
  const many = Array.from({ length: MAX_PROPOSALS + 5 }, (_, i) => rawTemplate({ title: `Distinct proposal number ${i}` }))
  const { deps, calls } = stubDeps({ generate: async () => reply(many) })
  const result = await generateTemplateProposals('org-1', deps)
  assert.equal(result.written, MAX_PROPOSALS)
  assert.equal(calls.written[0].length, MAX_PROPOSALS)
})

// --- process_improvement must target a real flow/agent id --------------------

test('process_improvement: a proposal targeting a real flow id is written; a fabricated id is dropped', async () => {
  const good = rawTemplate({
    kind: 'process_improvement',
    title: 'Speed up the weekly ops flow',
    instructions: '',
    integrations: [],
    schedule: '',
    exampleOutput: '',
    targetType: 'flow',
    targetId: 'flow-real',
    configJson: '{"notes":"add a filter step"}',
  })
  const bad = rawTemplate({
    kind: 'process_improvement',
    title: 'Improve a ghost agent',
    instructions: '',
    integrations: [],
    schedule: '',
    exampleOutput: '',
    targetType: 'agent',
    targetId: 'agent-does-not-exist',
    configJson: '{"notes":"x"}',
  })
  const { deps, calls } = stubDeps({
    readTargets: async () => ({ flows: [{ id: 'flow-real', name: 'Weekly ops' }], agents: [{ id: 'agent-real', name: 'Recap' }] }),
    generate: async () => reply([good, bad]),
  })
  const result = await generateTemplateProposals('org-1', deps)
  assert.equal(result.written, 1, 'only the proposal with a real target survives')
  const row = calls.written[0][0]
  assert.equal(row.kind, 'process_improvement')
  const config = row.configuration as Record<string, unknown>
  assert.equal(config.targetType, 'flow')
  assert.equal(config.targetId, 'flow-real')
  assert.equal(config.notes, 'add a filter step')
})

// --- parse failure is a graceful skip ---------------------------------------

test('a non-JSON model reply returns skipped:parse without writing', async () => {
  const { deps, calls } = stubDeps({ generate: async () => 'not json at all' })
  const result = await generateTemplateProposals('org-1', deps)
  assert.deepEqual(result, { written: 0, skipped: 'parse' })
  assert.equal(calls.written.length, 0)
})

// --- Pure helpers -----------------------------------------------------------

test('normalizeTitle: lowercases and collapses whitespace', () => {
  assert.equal(normalizeTitle('  Deal   Risk  Digest '), 'deal risk digest')
})

test('intentKey: order-independent, stopword-stripped', () => {
  assert.equal(intentKey('Weekly deal-risk digest'), intentKey('The digest of deal risk, weekly'))
  assert.notEqual(intentKey('Deal risk digest'), intentKey('Pipeline forecast recap'))
})

test('dedupeProposals: drops within-batch and against existing', () => {
  const kept = dedupeProposals(
    [{ title: 'Alpha report' }, { title: 'alpha  report' }, { title: 'Beta digest' }],
    ['beta digest'],
  )
  assert.deepEqual(kept.map((p) => p.title), ['Alpha report'])
})

test('tolerantObject: parses fenced JSON and defaults to {} on junk', () => {
  assert.deepEqual(tolerantObject('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(tolerantObject('{"b":2}'), { b: 2 })
  assert.deepEqual(tolerantObject('nope'), {})
  assert.deepEqual(tolerantObject(''), {})
  assert.deepEqual(tolerantObject('[1,2]'), {}, 'a non-object is discarded')
})

test('parseProposalsReply: reads the proposals array, tolerant of a bare array', () => {
  assert.equal(parseProposalsReply(JSON.stringify({ proposals: [rawTemplate()] })).length, 1)
  assert.equal(parseProposalsReply(JSON.stringify([rawTemplate()])).length, 1)
  assert.equal(parseProposalsReply(JSON.stringify({ nope: true })).length, 0)
})

test('normalizeProposal: unknown kind or empty title is dropped', () => {
  const ctx: NormalizeContext = { profile, flowIds: new Set(), agentIds: new Set() }
  assert.equal(normalizeProposal(rawTemplate({ kind: 'garbage' }), ctx), null)
  assert.equal(normalizeProposal(rawTemplate({ title: '   ' }), ctx), null)
})

test('normalizeProposal: template integrations are filtered to known providers', () => {
  const ctx: NormalizeContext = { profile, flowIds: new Set(), agentIds: new Set() }
  const out = normalizeProposal(rawTemplate({ integrations: ['slack', 'not-a-provider', 'slack'] }), ctx)
  const config = out!.configuration as Record<string, unknown>
  assert.deepEqual(config.integrations, ['slack'], 'unknown provider dropped, dedeuped')
})

test('usageSignals: bounded, PII-free signal bundle', () => {
  const signals = usageSignals(profile)
  assert.deepEqual(signals.providers, ['slack', 'people.ai', 'salesforce'])
  assert.equal(signals.runCount, 20)
})

test('runsAnalyzedLine: an unsampled profile states the exact run count plainly', () => {
  assert.equal(
    runsAnalyzedLine({ runCount: 20, windowDays: 90, sampled: false }),
    'Runs analyzed: 20 over the last 90 days.',
  )
})

test('runsAnalyzedLine: a sampled profile says so in plain English, naming the cap', () => {
  assert.equal(
    runsAnalyzedLine({ runCount: MAX_AUDIT_ROWS, windowDays: 90, sampled: true }),
    `Runs analyzed: ${MAX_AUDIT_ROWS} runs from the most recent ${MAX_AUDIT_ROWS} events, over the last 90 days.`,
  )
})

test('PROPOSAL_SCHEMA: strict object with a required proposals array', () => {
  assert.equal(PROPOSAL_SCHEMA.type, 'object')
  assert.equal(PROPOSAL_SCHEMA.additionalProperties, false)
  assert.deepEqual([...PROPOSAL_SCHEMA.required], ['proposals'])
})

// --- Boundaries: what actually reaches the model ----------------------------

/**
 * Asserted through the injected `generate` rather than on the exported
 * constant, because the constant is not the thing under test — the argument is.
 * An accepted proposal promotes to a live, tool-using agent or flow, so the one
 * question worth pinning is whether the call that authors it was made with the
 * boundaries attached. A reply cannot answer that: an unguarded model returns
 * perfectly ordinary-looking proposals.
 */
function captureSystemPrompt() {
  const seen: Array<{ system: string; user: string }> = []
  return {
    seen,
    generate: async (opts: { system: string; user: string }) => {
      seen.push({ system: opts.system, user: opts.user })
      return reply([rawTemplate()])
    },
  }
}

test('boundaries: the system prompt sent to the model carries GUARDRAIL_RULE verbatim', async () => {
  const spy = captureSystemPrompt()
  const { deps } = stubDeps({ generate: spy.generate })
  await generateTemplateProposals('org-1', deps)

  assert.equal(spy.seen.length, 1)
  assert.ok(
    spy.seen[0].system.includes(GUARDRAIL_RULE),
    'an accepted proposal becomes something that runs — it must be authored under the boundaries',
  )
  // Byte-identical: a paraphrased local copy would drift away from guardrails.ts.
  assert.equal(spy.seen[0].system.slice(spy.seen[0].system.indexOf(GUARDRAIL_RULE)), GUARDRAIL_RULE)
})

test('boundaries: they sit in the system prompt, not beside the workspace evidence', async () => {
  const spy = captureSystemPrompt()
  const { deps } = stubDeps({ generate: spy.generate })
  await generateTemplateProposals('org-1', deps)

  const { system, user } = spy.seen[0]
  assert.ok(user.includes('## Observed usage'), 'the usage evidence is the user turn')
  assert.equal(
    user.includes(GUARDRAIL_RULE),
    false,
    'retrieved context can argue with a rule it shares a turn with',
  )
  assert.ok(
    system.indexOf(UNTRUSTED_DATA_RULE) < system.indexOf(GUARDRAIL_RULE),
    'fence first, boundaries last — the order every other surface composes',
  )
})
