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
 * Three assertions hold that direction, and it is worth being exact about what
 * each one can and cannot do, because an earlier draft of this comment claimed
 * a guarantee the code did not make:
 *
 *   - A new model-calling file with no rule fails, unless someone writes it
 *     into one of the two maps by hand.
 *   - A listed file that gains the rule, or stops calling a model, fails until
 *     its entry is deleted. Debt cannot be paid off and left on the books.
 *   - The list's LENGTH is pinned, so growing it means raising a number that
 *     exists only to be argued with. That is the honest limit of a ratchet
 *     living in the same file as the list it guards: it cannot make laundering
 *     a new gap in here impossible, only impossible to do quietly. Without it,
 *     a one-line addition turned a red build green with nothing to notice in
 *     review — which is exactly how the population this guard was written for
 *     accumulated in the first place.
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
 */
const LLM_CALL =
  /\b(generateStructured|generateText|runModel|streamText|callModel|createModelRunner|anthropic\.messages|messages\.create)\b/

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
 */
const EXEMPT: Record<string, string> = {
  // The agent runtime DOES carry the rule — composed into its system prompt by
  // features/agents/system-prompt.ts, which is where the rest of the agent's
  // framing lives too. This file imports only isGuardrailRefusal, to detect a
  // refusal in the reply. Exempt because the rule reaches the model, not
  // because it is unnecessary.
  'features/agents/execute-agent.ts': 'Carries GUARDRAIL_RULE via features/agents/system-prompt.ts.',
  // 1–2 word role labels for gallery cards, batched. Every answer goes through
  // sanitizeRoleLabel before it is stored or rendered, so the output channel is
  // two clamped words wide — nothing the boundaries describe fits through it.
  'app/api/agents/role-labels/route.ts': 'Emits 1–2 word labels clamped by sanitizeRoleLabel.',
  // Both AI searches rank an already-authorised catalogue the caller sent, and
  // return ids the route resolves back against that same list. The model picks
  // from a closed set; it does not author anything the user keeps.
  'app/api/integrations/ai-search/route.ts': 'Ranks a caller-supplied catalogue; returns ids resolved against it.',
  'app/api/templates/ai-search/route.ts': 'Ranks a caller-supplied catalogue; output clamped by sanitizeMatches.',
  // The eval harness runs over CHECKED-IN FIXTURES, not live user data, and
  // only in development (skipped in CI without a key). Holding a fixture the
  // repo authored to the boundaries would test the boundaries, not the product.
  'lib/eval/judge.ts': 'Dev-only eval over checked-in fixtures.',
  'lib/eval/nightly.ts': 'Dev-only eval over checked-in fixtures.',
  'lib/eval/rag/answer.ts': 'Dev-only eval over checked-in fixtures.',
  'lib/eval/rag/generate.ts': 'Dev-only eval over checked-in fixtures.',
  'lib/eval/rag/judge.ts': 'Dev-only eval over checked-in fixtures.',
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
 * what it generates. Recorded 2026-08-29 while writing this guard.
 *
 * These are not exemptions and must not be reworded into any. Every one of
 * them either authors an artifact the workspace keeps and executes, or feeds
 * free-form prose into a step that acts — which is precisely the population
 * guardrails.ts says the rule is for ("every system prompt that produces
 * artifacts or takes actions").
 *
 * Two are worth calling out. api/chat is a second INTERACTIVE surface without
 * the rule, alongside the librarian; the hardening spec called the librarian
 * "the only interactive LLM surface without GUARDRAIL_RULE" because the
 * fencing detector could not see this route either. And run-action-step.ts
 * was expected to inherit its fencing exemption, which does not transfer:
 * lib/flows/ai-prompts.ts SYSTEM carries a fencing line and no boundaries at
 * all, so nothing downstream of it is covered.
 */
const MISSING_RULE: Record<string, string> = {
  'app/api/agents/draft/route.ts': 'Drafts an agent — title, description, operating instructions, integrations, schedule — that then runs with tools.',
  'app/api/chat/route.ts': 'Interactive Q&A over a run record carrying whatever the agent’s tools returned.',
  'app/api/flows/[id]/huddle/summary/route.ts': 'Summarises a captured human huddle into a persisted note and a decision list.',
  'features/agents/reflection.ts': 'Writes free-form learnings and a suggested goal into agent memory, replayed into later runs.',
  'features/flows/run-action-step.ts': 'Runs the flow `ai` step, whose free-text ask/summarize output feeds steps that send and write.',
  'lib/flows/reflection-sweep.ts': 'Writes a process_improvement TemplateProposal from a recurring failure pattern.',
  'lib/flows/templates/draft-notes.ts': 'Drafts the documentation saved with a flow template for other people to run.',
  'lib/templates/generate-proposals.ts': 'Proposes agent and flow templates that promote to live, tool-using automations on accept.',
}

/**
 * How many gaps were on the books when this guard was written, and therefore
 * the most there may ever be again.
 *
 * Asserted exactly rather than as a ceiling, so the number walks DOWN with the
 * list and no headroom is ever left behind for a later gap to slip into. The
 * cost is one digit to edit when a gap is closed; the point is that adding one
 * costs the same edit in the other direction, with a message attached.
 */
const MISSING_RULE_BASELINE = 8

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

function llmCallers(): string[] {
  return sourceFiles(SRC)
    .filter((file) => {
      const source = readFileSync(file, 'utf8')
      // The runner and its own helpers define the calls rather than making them.
      if (file.includes(path.join('lib', 'llm'))) return false
      return LLM_CALL.test(source)
    })
    .map((file) => path.relative(SRC, file))
}

describe('guardrail coverage', () => {
  it('still finds the model call sites it is meant to guard, so a renamed helper fails loudly instead of passing vacuously', () => {
    const callers = llmCallers()
    assert.ok(callers.length >= 5, `expected several LLM call sites, found ${callers.length}`)
  })

  it('sees the routes that call the Messages API through a client variable, which the inherited detector missed entirely', () => {
    // The pin that keeps the widened detector honest. If api/librarian ever
    // stops matching, this guard silently stops covering the one surface the
    // hardening spec was written for — a vacuous pass with no failing test.
    const callers = llmCallers()
    assert.ok(
      callers.includes(path.join('app', 'api', 'librarian', 'route.ts')),
      'the librarian route no longer matches the detector — widen LLM_CALL rather than losing the coverage',
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

  it('makes the gap list shrink or argue, because a new unguarded surface could otherwise be laundered into it in one green line', () => {
    // The gap that was actually here: the two assertions above fail a NEW
    // unguarded file and fail a CLOSED one, and between them they still let a
    // developer add the file to MISSING_RULE with a plausible sentence and
    // watch CI go green. "Known debt" is the softest word in the file and the
    // least likely to be challenged in review; nothing counted the list, so
    // nothing noticed it growing.
    assert.equal(
      Object.keys(MISSING_RULE).length,
      MISSING_RULE_BASELINE,
      'MISSING_RULE changed size. If you CLOSED a gap, lower MISSING_RULE_BASELINE to match — well done. ' +
        'If you are RAISING it, stop: you are recording a brand-new surface that reaches a model with no ' +
        'boundaries, and this list only goes down. Import GUARDRAIL_RULE into that surface instead, or ' +
        'exempt it with a reason naming why no boundary can bite.',
    )
  })

  it('never lets a file sit in both maps, so a gap cannot be quietly reclassified as a decision', () => {
    const both = Object.keys(MISSING_RULE).filter((relative) => relative in EXEMPT)

    assert.deepEqual(both, [], `these files are both exempt and a known gap: ${both.join(', ')}`)
  })
})
