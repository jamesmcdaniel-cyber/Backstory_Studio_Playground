import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Sibling of llm-fencing-coverage.test.ts, and it exists because that guard
 * worked exactly as designed and still let gap 4 through.
 *
 * The fencing guard obliges every model-calling surface to say "untrusted
 * content is data, not instructions". It says nothing about what the model is
 * not allowed to DO, so every surface added since inherited the fence and none
 * inherited the boundaries. Two different controls, one of them unenforced —
 * which is the same shape as the failure the fencing guard itself was written
 * to end.
 *
 * So: every file that reaches a model must import GUARDRAIL_RULE, or carry a
 * written exemption. The file list comes off the filesystem for the reason the
 * fencing guard states — enumerating today's routes is what leaves the tenth
 * one to reopen the hole.
 *
 * ── Two maps, deliberately ─────────────────────────────────────────────────
 *
 * EXEMPT is for files where the boundaries genuinely have no purchase.
 * MISSING_RULE is for files where they do, and the rule is simply not there
 * yet. Collapsing the second into the first is how a gap becomes permanent:
 * "exempt" reads as a decision, and nobody revisits a decision. A gap list is
 * read as debt, so it is held to a direction of travel rather than just a
 * reason per line.
 *
 * MISSING_RULE is now EMPTY, which changes what this file asserts rather than
 * retiring it. The pin used to say "the debt may only shrink"; it now says
 * "no surface reaches a model without the boundaries, and none may be added
 * that does". The three assertions are unchanged, and it is worth being exact
 * about what each one does at zero, because an earlier draft of this comment
 * claimed a guarantee the code did not make:
 *
 *   - A new model-calling file with no rule fails, unless someone writes it
 *     into one of the two maps by hand. At zero, that is the only way in.
 *   - A listed file that gains the rule, or stops calling a model, fails until
 *     its entry is deleted. Debt cannot be paid off and left on the books —
 *     which is why the list is empty rather than historical: the eight gaps
 *     this file opened with on 2026-08-29 were each closed at the surface and
 *     struck off here in the same pass, because leaving one listed after the
 *     fix would have failed this guard just as loudly as never fixing it.
 *   - The list's LENGTH is pinned, so growing it means raising a number that
 *     exists only to be argued with. That is the honest limit of a ratchet
 *     living in the same file as the list it guards: it cannot make laundering
 *     a new gap in here impossible, only impossible to do quietly. Without it,
 *     a one-line addition turned a red build green with nothing to notice in
 *     review — which is exactly how the population this guard was written for
 *     accumulated in the first place. At zero there is no headroom left for
 *     anything to slip into, which makes an empty map plus a pinned zero the
 *     opposite of spare scaffolding to clear away now the debt is paid: it is
 *     the state being defended.
 */

const SRC = path.join(process.cwd(), 'src')

/**
 * How a file betrays that it sends text to a model.
 *
 * Character-identical to the fencing guard's detector, deliberately: the two
 * guards must reason over the same population, or a surface can be fenced by
 * one and invisible to the other. Diff them if either is ever touched.
 *
 * `messages\.create` is why this comment exists. The `anthropic\.messages`
 * alternative both guards inherited matches NOTHING in this tree: the two
 * routes that speak the Messages API directly build a client first
 * (`const client = useClaude ? new Anthropic(…) : qwenClient()`) and then call
 * `client.messages.create`. Both were therefore invisible to the fencing
 * guard for its whole life — including api/librarian/route.ts, the surface
 * this hardening pass was written for. A guard blind to the file it was
 * written for is the vacuous pass the self-checks below exist to prevent, so
 * the widening was made here and then backported into the fencing guard,
 * which now pins the same two routes by name.
 *
 * `createPinnedRunner` is the second widening, and it is the same mistake in a
 * quieter place: it is `createModelRunner`'s sibling — same module, same
 * ModelRunner, one built without the fallback chain — so naming only one of the
 * two constructors left lib/eval/bench.ts outside EXEMPT and MISSING_RULE
 * alike. Not a gap on the books and not a decision: simply unseen, by both
 * guards, which is the one state neither can report on.
 */
const LLM_CALL =
  /\b(generateStructured|generateText|runModel|streamText|callModel|createModelRunner|createPinnedRunner|anthropic\.messages|messages\.create)\b/

/**
 * Each alternative inside LLM_CALL, as its own detector.
 *
 * Derived from the regex rather than restated beside it: a second hand-written
 * list is a second thing to forget, and the self-check below is worth nothing
 * if it can measure a population the real detector no longer matches.
 */
function llmCallAlternatives(): RegExp[] {
  const inner = LLM_CALL.source.replace(/^\\b\(/, '').replace(/\)\\b$/, '')
  return inner.split('|').map((alternative) => new RegExp(`\\b(${alternative})\\b`))
}

/**
 * What counts as carrying the boundaries.
 *
 * Matching the IDENTIFIER, not the module path the fencing guard matches. The
 * guardrails module also exports `isGuardrailRefusal`, which reads a reply
 * AFTER the fact; a file that imports only that has consumed the marker
 * without ever sending the rule to a model. Matching '@/lib/security/guardrails'
 * would score execute-agent.ts as covered on exactly that basis.
 */
const GUARDRAIL = /\bGUARDRAIL_RULE\b/

/**
 * Files that reach a model but where none of the five boundaries can bite.
 * Each needs a reason, and the reason has to name the mechanism. "It seemed
 * low risk" is not one — the copilots looked low risk too, right up until
 * imported flow graphs became one of their inputs.
 *
 * The pattern that earns an exemption: the model's output is a label, a score,
 * a ranking or an id, clamped by a sanitizer or an enum before anything is
 * stored or shown. There is no free-form channel for a leaked credential, a
 * forged sender, or a destructive instruction to travel down.
 *
 * "Clamped" has to describe the WHOLE output, and the two AI-search routes are
 * why that is spelled out. Both were exempt on the strength of their ids —
 * resolved against a catalogue the caller sent, so a hallucinated one dies at
 * the route — while each match also carried a `reason`, a sentence the model
 * writes and the route returns verbatim as the product's own explanation of a
 * match. A sanitizer over one field of a record is not a clamp on the record;
 * the prose beside it was the free-form channel this paragraph says does not
 * exist, fed by a catalogue that includes text other workspaces contributed.
 * Both are now guarded rather than exempt, and the same question — what ELSE
 * comes back alongside the clamped part — is the one to ask of the next entry.
 */
const EXEMPT: Record<string, string> = {
  // The agent runtime DOES carry the rule — composed into its system prompt by
  // features/agents/system-prompt.ts, which is where the rest of the agent's
  // framing lives too. This file imports only isGuardrailRefusal, to detect a
  // refusal in the reply. Exempt because the rule reaches the model, not
  // because it is unnecessary.
  'features/agents/execute-agent.ts': 'Carries GUARDRAIL_RULE via features/agents/system-prompt.ts.',
  // The flow `ai` step DOES carry the rule: lib/flows/ai-prompts.ts composes it
  // into the shared SYSTEM every op returns, and this file passes that exact
  // string to runner.next(...) as the system argument. One addition there
  // covers all five ops, because all five share the constant.
  //
  // This entry deliberately does NOT reuse the fencing guard's wording. That
  // exemption ("AI-step fencing lives in ai-prompts.ts SYSTEM") was true and
  // was then read as covering this guard too — but ai-prompts.ts SYSTEM carried
  // a fencing line and no boundaries at all, so the inference was false for
  // every day it stood. An exemption is only ever evidence about the control it
  // names; the fix was to put the boundaries in the same place the fence is,
  // and this line asserts that they are now actually there.
  'features/flows/run-action-step.ts': 'AI-step boundaries live in lib/flows/ai-prompts.ts SYSTEM, passed here as runner.next(…) system.',
  // 1–2 word role labels for gallery cards, batched. Every answer goes through
  // sanitizeRoleLabel before it is stored or rendered, so the output channel is
  // two clamped words wide — nothing the boundaries describe fits through it.
  'app/api/agents/role-labels/route.ts': 'Emits 1–2 word labels clamped by sanitizeRoleLabel.',
  // The eval harness runs over CHECKED-IN FIXTURES, not live user data, and
  // only in development (skipped in CI without a key). Holding a fixture the
  // repo authored to the boundaries would test the boundaries, not the product.
  'lib/eval/judge.ts': 'Dev-only eval over checked-in fixtures.',
  'lib/eval/nightly.ts': 'Dev-only eval over checked-in fixtures.',
  'lib/eval/rag/answer.ts': 'Dev-only eval over checked-in fixtures.',
  'lib/eval/rag/generate.ts': 'Dev-only eval over checked-in fixtures.',
  'lib/eval/rag/judge.ts': 'Dev-only eval over checked-in fixtures.',
  // Bench is the second exemption here that is NOT dev-only — Admin → Models
  // runs it on real spend — so, like shadow eval, it qualifies on mechanism
  // rather than on being a script. Every prompt it sends is a checked-in
  // fixture's own `system` and `input`, every tool return is that fixture's
  // authored script, and the only free-form text it keeps is the judge's
  // sentence ABOUT a fixture we wrote. Nothing a boundary describes has an
  // origin here: no workspace text goes in and no connected system is touched.
  'lib/eval/bench.ts': 'Prompts checked-in fixtures against a pinned runner; no workspace text, and every tool return is the fixture\'s own script.',
  // Shadow eval is the one exemption here that is NOT dev-only — it samples
  // real production tasks. It qualifies anyway, on two counts: the challenger
  // is handed the champion's own system prompt verbatim, so it inherits
  // whatever rules that surface already carried rather than composing new
  // ones; and the judge's only retained output is two numbers in [0,1]. The
  // module comment is explicit that the text is never stored.
  'lib/eval/shadow.ts': 'Replays the champion prompt verbatim; retains only numeric scores.',
}

/**
 * Files where the boundaries DO apply and the rule is not there yet, each with
 * what it generates.
 *
 * Empty since 2026-08-29, and the emptiness is the assertion. This map opened
 * with eight entries; every one was closed by importing GUARDRAIL_RULE into
 * the surface and composing it into the SYSTEM prompt the model actually
 * receives — never into the user turn, because a boundary sitting beside
 * attacker-influenceable content is a boundary that content can argue with.
 *
 * Keep the map. An entry here remains the only alternative to fixing a
 * surface, and it is deliberately the more expensive one: it costs a sentence
 * naming what the file generates, a raised baseline below, and a reviewer who
 * has to agree — against one import and one array element. The test that
 * something belongs here rather than in EXEMPT is unchanged: it authors an
 * artifact the workspace keeps and executes, or feeds free-form prose into a
 * step that acts, which is the population guardrails.ts says the rule is for
 * ("every system prompt that produces artifacts or takes actions"). These are
 * not exemptions and must not be reworded into any.
 */
const MISSING_RULE: Record<string, string> = {}

/**
 * How many gaps are on the books. Zero.
 *
 * Asserted exactly rather than as a ceiling, so the number walked DOWN with
 * the list — 8 to 0 — and left no headroom behind for a later gap to slip
 * into. At zero the assertion inverts: it used to catch a gap closed at the
 * surface but left listed here, and it now catches the first surface that
 * reaches a model with no boundaries, because raising this is the only way to
 * record one. That raise is a deliberate line in a diff with a message
 * attached, which is all a ratchet living in the same file as its list can
 * offer — and still more than the silence the original eight accumulated in.
 */
const MISSING_RULE_BASELINE = 0

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      sourceFiles(full, acc)
    } else if (/\.tsx?$/.test(entry)) {
      acc.push(full)
    }
  }
  return acc
}

/**
 * lib/llm is the runner's own plumbing — ir.ts, qwen.ts, provider-brand.ts —
 * and those files describe transport or DEFINE the helpers other surfaces call.
 * They compose no prompt of their own, so there is no system prompt for the
 * boundaries to be composed into.
 *
 * model-runner.ts is the exception, and the directory-wide skip is what hid it.
 * The comment that used to sit here said the runner "defines the calls rather
 * than making them", which was true of the file's other 800 lines and false of
 * generateHeadline: it writes its own system prompt, calls messages.create, and
 * bills its own ledger surface, over an agent's closing summary — model-authored
 * text built on whatever that run's tools returned. The reply is clamped to one
 * line of 120 characters, which bounds what a successful injection wins; being
 * outside the population meant nothing was even asking.
 *
 * So the skip is narrowed to the plumbing it was always describing. Named as
 * one file rather than a rule about who is allowed to prompt, for the reason
 * the run-action-step exemption gives above: the next lib/llm file that starts
 * prompting a model should have to say so here.
 */
const RUNNER_PLUMBING = path.join('lib', 'llm')
const RUNNER_FILE_THAT_PROMPTS = path.join('lib', 'llm', 'model-runner.ts')

function llmCallers(): string[] {
  return sourceFiles(SRC)
    .filter((file) => {
      if (file.includes(RUNNER_PLUMBING) && !file.endsWith(RUNNER_FILE_THAT_PROMPTS)) return false
      return LLM_CALL.test(readFileSync(file, 'utf8'))
    })
    .map((file) => path.relative(SRC, file))
}

describe('guardrail coverage', () => {
  it('still finds the model call sites it is meant to guard, so a renamed helper fails loudly instead of passing vacuously', () => {
    const callers = llmCallers()
    assert.ok(callers.length >= 5, `expected several LLM call sites, found ${callers.length}`)

    // The floor alone did not earn this test's name. The population is
    // lopsided — the overwhelming majority of these files reach a model through
    // ONE helper, and the handful using every other spelling clear a floor of
    // five between them — so renaming the busy one could drop most of the
    // guarded set while this still passed. That is the vacuous pass, arrived at
    // from the other direction.
    //
    // Concentration is the property that actually holds: the busiest
    // alternative accounts for most of what is matched, so if it stops
    // matching, no remainder can satisfy the ratio. A ratio and not a count,
    // deliberately — a number pinned near today's population has to be raised
    // every time a route is added, which teaches everyone to raise it without
    // reading it.
    //
    // Measured over the CALLERS, not the definer: model-runner.ts exports every
    // spelling in LLM_CALL, so it matches all of them and is evidence about
    // none. Counting it inflates the alternatives it declares, which is the direction
    // that flatters a helper nobody uses any more.
    const measured = callers.filter((relative) => relative !== RUNNER_FILE_THAT_PROMPTS)
    const sources = new Map(measured.map((relative) => [relative, readFileSync(path.join(SRC, relative), 'utf8')]))
    const perAlternative = llmCallAlternatives().map(
      (alternative) => measured.filter((relative) => alternative.test(sources.get(relative)!)).length,
    )
    const dominant = Math.max(...perAlternative)

    assert.ok(
      dominant * 2 > measured.length,
      `the busiest LLM_CALL alternative covers ${dominant} of ${measured.length} matched files — no longer a ` +
        'majority. Either the helper most of this tree prompts through was renamed and the detector stopped ' +
        'seeing it, which is what this check is for: widen LLM_CALL rather than accepting the smaller set. Or a ' +
        'second helper has genuinely grown to rival the first — in which case confirm the original still matches ' +
        'something before reshaping this assertion, because a rename looks identical from here until you check.',
    )
  })

  it('sees the routes that call the Messages API through a client variable, which the inherited detector missed entirely', () => {
    // The pin that keeps the widened detector honest. If either route stops
    // matching, this guard silently stops covering an interactive assistant
    // over retrieved workspace text — a vacuous pass with no failing test.
    //
    // BOTH are named, which this check used to claim and not do. The comment on
    // LLM_CALL says "the two routes that speak the Messages API directly" and
    // only api/librarian was asserted, so api/chat — matched by nothing but the
    // messages.create alternative — could have changed call shape and dropped
    // out of the population with every assertion in this file still green. The
    // fencing guard has pinned the pair since it was widened; this is the same
    // list, checked the same way, so the two can be diffed.
    const callers = llmCallers()
    const directSdk = [
      path.join('app', 'api', 'librarian', 'route.ts'),
      path.join('app', 'api', 'chat', 'route.ts'),
    ]
    const missed = directSdk.filter((relative) => !callers.includes(relative))

    assert.deepEqual(
      missed,
      [],
      `LLM_CALL no longer matches these direct-SDK routes: ${missed.join(', ')}. ` +
        'They call client.messages.create rather than a lib/llm helper — widen the detector rather than ' +
        'losing the coverage, and only delete an entry here once the route genuinely stops prompting a model.',
    )
  })

  it('pins a file by name behind every live detector alternative', () => {
    // Neither of these was guarded OR exempt OR a recorded gap — they were
    // outside the population, the one state no assertion in this file can
    // report on. bench.ts drives a model through createPinnedRunner, a spelling
    // LLM_CALL did not list; model-runner.ts prompts one in generateHeadline
    // and was skipped for living under lib/llm. Pinned by name because a count
    // cannot notice an absence, which is the lesson of the direct-SDK pin above.
    const callers = llmCallers()
    const pinned = [
      path.join('lib', 'eval', 'bench.ts'),
      path.join('lib', 'llm', 'model-runner.ts'),
      // createModelRunner's only carriers. They are pinned because deleting
      // that alternative fails NOTHING except the stale-exemption assertion,
      // whose message says "remove these stale exemptions" — and following it
      // turns the build green with these three outside the population
      // entirely. A tripwire whose own advice completes the laundering is not
      // a tripwire; every live alternative needs a file pinned by name behind
      // it.
      path.join('features', 'agents', 'execute-agent.ts'),
      path.join('features', 'flows', 'run-action-step.ts'),
      path.join('lib', 'eval', 'nightly.ts'),
    ]
    const missed = pinned.filter((relative) => !callers.includes(relative))

    assert.deepEqual(
      missed,
      [],
      `these files reach a model but are outside the guarded population again: ${missed.join(', ')}. ` +
        'Restore the LLM_CALL alternative or the lib/llm carve-out that caught them — an unmatched file is ' +
        'neither guarded nor exempt, it is simply unwatched.',
    )
  })

  it('holds every surface that produces an artifact or takes an action to the shared boundaries', () => {
    const unguarded: string[] = []

    for (const relative of llmCallers()) {
      if (relative in EXEMPT || relative in MISSING_RULE) continue
      const source = readFileSync(path.join(SRC, relative), 'utf8')
      if (!GUARDRAIL.test(source)) unguarded.push(relative)
    }

    assert.deepEqual(
      unguarded,
      [],
      `these surfaces prompt a model without the shared boundaries: ${unguarded.join(', ')}. ` +
        'Import GUARDRAIL_RULE from @/lib/security/guardrails and compose it into the system prompt, ' +
        'or add the file to EXEMPT with a reason naming why no boundary can bite.',
    )
  })

  it('only exempts files that still call a model', () => {
    const callers = new Set(llmCallers())
    const stale = Object.keys(EXEMPT).filter((relative) => !callers.has(relative))

    assert.deepEqual(stale, [], `remove these stale guardrail exemptions: ${stale.join(', ')}`)
  })

  it('only records gaps that are still gaps, so closing one forces the list to shrink', () => {
    // Vacuous while MISSING_RULE is empty, and left in place for that reason:
    // it is what stops the next entry — if there ever is one — from outliving
    // its own fix. A guard is allowed to be quiet in the state it enforces.
    const callers = new Set(llmCallers())
    const fixed: string[] = []

    for (const relative of Object.keys(MISSING_RULE)) {
      if (!callers.has(relative)) {
        fixed.push(relative)
        continue
      }
      const source = readFileSync(path.join(SRC, relative), 'utf8')
      if (GUARDRAIL.test(source)) fixed.push(relative)
    }

    assert.deepEqual(
      fixed,
      [],
      `these files now carry GUARDRAIL_RULE (or no longer call a model) — delete them from MISSING_RULE: ${fixed.join(', ')}. ` +
        'The list is asserted exactly so it can only shrink; leaving a closed gap in it is how the list stops meaning anything.',
    )
  })

  it('makes a new gap argue for itself, because an unguarded surface could otherwise be laundered into the list in one green line', () => {
    // The gap that was actually here: the two assertions above fail a NEW
    // unguarded file and fail a CLOSED one, and between them they still let a
    // developer add the file to MISSING_RULE with a plausible sentence and
    // watch CI go green. "Known debt" is the softest word in the file and the
    // least likely to be challenged in review; nothing counted the list, so
    // nothing noticed it growing. Now that the count is zero, this is the
    // whole ratchet: there is nothing left to close, so any change here is a
    // raise, and a raise cannot happen without someone editing the number.
    assert.equal(
      Object.keys(MISSING_RULE).length,
      MISSING_RULE_BASELINE,
      'MISSING_RULE is no longer empty. Every gap this file opened with has been closed, so this can only be ' +
        'a RAISE: you are recording a brand-new surface that reaches a model with no boundaries. Import ' +
        'GUARDRAIL_RULE from @/lib/security/guardrails into that surface and compose it into the SYSTEM ' +
        'prompt (never the user turn) instead, or exempt it with a reason naming why no boundary can bite. ' +
        'If you really mean to book the debt, raise MISSING_RULE_BASELINE in the same commit and say why.',
    )
  })

  it('never lets a file sit in both maps, so a gap cannot be quietly reclassified as a decision', () => {
    const both = Object.keys(MISSING_RULE).filter((relative) => relative in EXEMPT)

    assert.deepEqual(both, [], `these files are both exempt and a known gap: ${both.join(', ')}`)
  })
})
