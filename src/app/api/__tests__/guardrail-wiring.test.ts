import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { GUARDRAIL_RULE, GUARDRAIL_REFUSAL_MARKER } from '@/lib/security/guardrails'

/**
 * Five routes that reached a model with no boundaries, and what keeps them
 * from drifting back.
 *
 * The last two arrived by a different road than the first three. Both AI
 * searches were EXEMPT in the coverage guard rather than unguarded, on the
 * strength of their ids: the model ranks a catalogue the caller sent and the
 * route resolves every id back against that same list, so a hallucinated one
 * dies at the route. True, and beside the point — each match also carries a
 * `reason`, a sentence the model writes that both routes return verbatim as the
 * product's own explanation of the match. A sanitizer over one field is not a
 * clamp on the record, and the catalogue those sentences are written from
 * includes descriptions other workspaces contributed. Free-form prose out of
 * attacker-influenceable text in is the pair the boundaries exist for, so the
 * exemptions were removed and the rule composed in.
 *
 * lib/security/__tests__/guardrail-coverage.test.ts already fails a surface
 * that never mentions GUARDRAIL_RULE, so it would catch the identifier being
 * deleted outright. What it cannot see is WHERE the rule ended up: a file that
 * imports the constant and interpolates it into the user turn matches its
 * detector perfectly and is not protected at all. A boundary sitting beside the
 * content it is meant to bind — a run record full of tool output, a transcript
 * nobody drafted — is a boundary that content is invited to argue with.
 *
 * So this asserts the shape of the composition, not merely the presence of the
 * name: the rule is in the system prompt, it is the LAST clause (after the
 * fencing rule each of these five already carried), and it appears nowhere else
 * in the file. That last one is the point of counting uses rather than just matching
 * one — a second occurrence is, by construction, an occurrence this file's
 * region checks did not look at.
 *
 * It reads source text, in the style of lib/librarian/__tests__/scope-wiring
 * .test.ts, and it is brittle on purpose. A refactor that renames these
 * compositions should stop and re-read this file, because the composition is
 * the control.
 */

const API = path.join(process.cwd(), 'src', 'app', 'api')

/**
 * Importing the constant rather than matching the string is the vacuity anchor:
 * if the export is renamed, this file fails to load instead of quietly
 * asserting on a name nothing produces any more.
 */
test('the rule the routes import is the real one', () => {
  assert.ok(GUARDRAIL_RULE.length > 200, 'GUARDRAIL_RULE should be the full boundary list')
  assert.ok(
    GUARDRAIL_RULE.includes(GUARDRAIL_REFUSAL_MARKER),
    'the rule must still instruct the model to prefix refusals with the marker, or nothing is auditable',
  )
})

const ROUTES = {
  draft: readFileSync(path.join(API, 'agents', 'draft', 'route.ts'), 'utf8'),
  chat: readFileSync(path.join(API, 'chat', 'route.ts'), 'utf8'),
  huddle: readFileSync(path.join(API, 'flows', '[id]', 'huddle', 'summary', 'route.ts'), 'utf8'),
  integrationSearch: readFileSync(path.join(API, 'integrations', 'ai-search', 'route.ts'), 'utf8'),
  templateSearch: readFileSync(path.join(API, 'templates', 'ai-search', 'route.ts'), 'utf8'),
} as const

/** Import plus exactly one use — see the header on why the count is pinned. */
function uses(source: string): number {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  return (code.match(/\bGUARDRAIL_RULE\b/g) ?? []).length
}

for (const [name, source] of Object.entries(ROUTES)) {
  test(`${name} imports the shared boundaries and uses them in exactly one place`, () => {
    assert.match(
      source,
      /import \{ GUARDRAIL_RULE \} from '@\/lib\/security\/guardrails'/,
      'the rule must be imported, never restated — a forked copy drifts and nobody diffs prompts',
    )
    assert.equal(
      uses(source),
      2,
      'expected the import and a single system-prompt use. A third occurrence is a use the region ' +
        'assertions below never inspected — if it is a second legitimate system prompt, widen this ' +
        'test to pin that composition too rather than raising the number.',
    )
  })
}

test('the agent drafter states the boundaries last, in the system prompt', () => {
  // The user turn here is the raw description someone typed. Whatever else
  // that text is, it must not be the thing carrying the rule that constrains it.
  assert.match(
    ROUTES.draft,
    /system: \[[\s\S]*?UNTRUSTED_DATA_RULE,\s*(?:\/\/[^\n]*\n\s*)*GUARDRAIL_RULE,\s*\]\.join\('\\n'\)/,
    'GUARDRAIL_RULE must close the system array, after the fencing rule',
  )
  assert.match(ROUTES.draft, /user: description,/, 'the user turn stays the plain description')
})

test('the run-chat route states the boundaries last, in the shared SYSTEM_PROMPT', () => {
  assert.match(
    ROUTES.chat,
    /const SYSTEM_PROMPT = \[[\s\S]*?UNTRUSTED_DATA_RULE,\s*GUARDRAIL_RULE,\s*\]\.join\('\\n\\n'\)/,
    'GUARDRAIL_RULE must close SYSTEM_PROMPT, after the fencing rule',
  )
  // The fenced run record — tool output, so the attacker-influenceable half —
  // travels in `prompt`, and `prompt` is only ever the user message.
  assert.match(ROUTES.chat, /system: SYSTEM_PROMPT,/, 'the composed prompt must be passed as the system prompt')
  assert.match(
    ROUTES.chat,
    /messages: \[\{ role: 'user', content: prompt \}\]/,
    'the fenced run record stays in the user turn, on the other side of the boundary from the rule',
  )
})

test('the huddle summariser states the boundaries last, in the system prompt', () => {
  assert.match(
    ROUTES.huddle,
    /const system = `[^`]*\$\{UNTRUSTED_DATA_RULE\}\\n\\n\$\{GUARDRAIL_RULE\}`/,
    'GUARDRAIL_RULE must close the system template, after the fencing rule',
  )
  // summaryPrompt() builds the user turn out of the transcript. If the rule
  // ever moved in there it would sit inside the speech it is meant to bound.
  assert.match(ROUTES.huddle, /const user = summaryPrompt\(/, 'the transcript stays in the user turn')
})

/**
 * Both searches compose the same three-part system prompt: what to match,
 * then the fence, then the boundaries. Asserted per route rather than once over
 * both, so a fix applied to one and forgotten on the other fails by name.
 */
const SEARCH_SYSTEM = /system: \[[\s\S]*?UNTRUSTED_DATA_RULE,\s*GUARDRAIL_RULE,\s*\]\.join\('\\n\\n'\)/

test('the integration finder states the boundaries last, in the system prompt', () => {
  assert.match(
    ROUTES.integrationSearch,
    SEARCH_SYSTEM,
    'GUARDRAIL_RULE must close the system array, after the fencing rule',
  )
  // The goal and the catalogue are the attacker-influenceable half — an
  // integration name, a provider string — and they stay in the user turn.
  assert.match(ROUTES.integrationSearch, /user: `Goal: \$\{query\}/, 'the catalogue stays in the user turn')
})

test('the template finder states the boundaries last, in the system prompt', () => {
  assert.match(
    ROUTES.templateSearch,
    SEARCH_SYSTEM,
    'GUARDRAIL_RULE must close the system array, after the fencing rule',
  )
  assert.match(ROUTES.templateSearch, /user: `Goal: \$\{query\}/, 'the catalogue stays in the user turn')
})

test('neither search is exempt from the coverage guard any more', () => {
  // The pair of assertions above pin WHERE the rule sits; this pins that
  // something still requires it to be there at all. Re-listing either route in
  // the coverage guard's EXEMPT map would make deleting the composition a green
  // change, which is exactly how these two sat unguarded to begin with.
  const guard = readFileSync(
    path.join(process.cwd(), 'src', 'lib', 'security', '__tests__', 'guardrail-coverage.test.ts'),
    'utf8',
  )
  const exempt = guard.slice(guard.indexOf('const EXEMPT'), guard.indexOf('const MISSING_RULE'))

  assert.equal(exempt.includes('integrations/ai-search'), false, 'the integration finder returns model-authored prose')
  assert.equal(exempt.includes('templates/ai-search'), false, 'the template finder returns model-authored prose')
})
