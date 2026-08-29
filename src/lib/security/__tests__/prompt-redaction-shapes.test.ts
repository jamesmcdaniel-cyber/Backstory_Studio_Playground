import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets } from '../prompt'

/**
 * Slack-shaped fixtures are ASSEMBLED at runtime rather than written out.
 *
 * GitHub push protection matches the literal `xox*-…-…-…` shape and rejects the
 * push — and it is right to: a secret scanner cannot tell a test fixture from a
 * live token, and one that tried would be the wrong scanner. Splitting the
 * prefix from the body keeps the literal out of the source while the value
 * redactSecrets actually sees stays byte-identical, so these tests exercise
 * exactly what they did before.
 */
const slackToken = (prefix: string) => `${prefix}-0000000000-0000000000-EXAMPLEnotarealtoken`


// The second half of redactSecrets' suite, split off from prompt.test.ts only
// because a single test file past ~45KB hangs tsx at load. Same subject, same
// weighting: the false-positive fixtures carry more weight than the
// true-positive ones, because a redactor that mangles ordinary workspace text
// gets switched off and then protects nothing.
//
// Every fixture below is a synthetic string in a real credential's SHAPE, or a
// real link/name shape that came back mangled. None is or was a live secret.

// ── redactSecrets, on a secret fused to the name that introduces it ────────
//
// `=`, `-` and `_` are all inside the run class, so a credential arrives in the
// same run as the identifier naming it — and the words in that identifier were
// enough on their own to push the run over the letters-per-run floor, sparing
// the label AND the key. Every fixture below is a pasted .env line, config key
// or callback URL, which is the text the module header describes someone
// dropping into a flow description while debugging an integration.

describe('redactSecrets, on a secret fused to the name that introduces it', () => {
  const KEY = '4OTUrW6hrzdU1OTZJDyk-ZJKWMZoVwWme-RZImVAwl4'
  const survives = (out: string) => assert.ok(!out.includes(KEY), `the key survived: ${out}`)

  it('redacts a key whose variable name is what carried the whole run over the name floor', () => {
    // 3.70 letters per run standing alone, 4.54 with SALESFORCE_CLIENT_SECRET=
    // glued on. The name goes with the value for the reason the query-string
    // case above gives: '=' is in the run class, and that only ever happens
    // where the value was a confirmed secret.
    const out = redactSecrets(`SALESFORCE_CLIENT_SECRET=${KEY}`)
    survives(out)
    assert.equal(out, '[redacted]')
  })

  it('redacts every key in a pasted .env block, not only the ones with short names', () => {
    const out = redactSecrets(
      [
        '# staging integration creds, do not commit',
        'SALESFORCE_INSTANCE_URL=https://acme.my.salesforce.com',
        `SALESFORCE_CLIENT_SECRET=${KEY}`,
        'SUPABASE_SERVICE_ROLE_KEY=M1wu5vz1FXCN9ZFQUOsgjisNzPXXRjnNUvabJt689Zo',
        'WEBHOOK_DIGEST=a3f5c9d1e7b2408596cd3fa1b7e0d24c',
      ].join('\n'),
    )
    survives(out)
    assert.ok(!out.includes('M1wu5vz1FXCN9ZFQUOsgjisNzPXXRjnNUvabJt689Zo'), 'the second key survived')
    // The endpoint is not a credential and stays legible; the comment does too.
    assert.match(out, /^# staging integration creds, do not commit\n/)
    assert.ok(out.includes('SALESFORCE_INSTANCE_URL=https://acme.my.salesforce.com'))
  })

  it('redacts a key introduced by a descriptive query parameter, which the URL rule promises stays in scope', () => {
    // A short '?k=' was always caught. The parameter name being descriptive is
    // what used to shelter the value it introduced.
    assert.equal(
      redactSecrets(`https://acme.com/v1?integration_client_secret=${KEY}`),
      'https://acme.com/v1?[redacted]',
    )
    assert.equal(redactSecrets(`https://acme.com/v1?k=${KEY}`), 'https://acme.com/v1?[redacted]')
  })

  it('redacts a key labelled with kebab-case words, before it or after it', () => {
    survives(redactSecrets(`production-salesforce-refresh-token-${KEY}`))
    survives(redactSecrets(`${KEY}-production-refresh-token`))
    survives(redactSecrets(`curl -d integration_client_secret=${KEY} https://api.acme.com/v1`))
  })

  it('leaves the workspace names whose words did that pushing alone, which is what makes the affix test safe', () => {
    // The counterweight: judging an affix by the same standard as the whole is
    // what keeps this off names — a name's tail is still a name.
    for (const name of [
      'Backfill-Contacts-From-Gong-Calls-Into-Salesforce-Nightly-V2',
      'MEDDPICC_Scorecard_Refresh_For_Open_Opportunities_2026',
      'Q3_2026_Pipeline_Review_Digest_For_AMER_Enterprise_Team',
      'Enterprise-Renewal-Risk-Digest-Owner-Handoff-2026-Q3',
    ]) {
      assert.equal(redactSecrets(name), name)
    }
  })
})

// ── redactSecrets, on the boundary one underscore used to erase ────────────

describe('redactSecrets, on a secret joined to its label by an underscore', () => {
  it('redacts a digest in a dated filename, which the same name written with hyphens never hid', () => {
    // '_' is a word character, so '\b' read the whole filename as one word and
    // the rule never fired. Which separator a logger reached for is not evidence
    // about the thing after it.
    assert.equal(
      redactSecrets('restore from backup_2026_08_29_a3f5c9d1e7b2408596cd3fa1b7e0d24c.sql'),
      'restore from backup_2026_08_29_[redacted].sql',
    )
  })

  it('redacts every prefixed shape behind an underscore, since one separator switched off five rules at once', () => {
    assert.equal(
      redactSecrets(`aws_key_AKIAIOSFODNN7EXAMPLE and slack_bot_${slackToken('xoxb')}`),
      'aws_key_[redacted] and slack_bot_[redacted]',
    )
    assert.equal(
      redactSecrets('openai_key_sk-proj-EXAMPLEnotarealkey000000000000 gh_token_ghp_EXAMPLEnotarealtoken000000000000000A'),
      'openai_key_[redacted] gh_token_[redacted]',
    )
    assert.ok(!redactSecrets('id_token_eyJhbGciOiJub25lIn0.eyJzdWIiOiJleGFtcGxlIn0.').includes('eyJ'))
  })

  it('still leaves a compound word alone, which is all the boundary was ever there for', () => {
    // Alphanumerics still block a match, so "risk-adjusted" is untouched — the
    // widening is to separators only.
    assert.equal(
      redactSecrets('Risk-adjusted forecast and a task-management rollout, both off-cycle.'),
      'Risk-adjusted forecast and a task-management rollout, both off-cycle.',
    )
  })
})

// ── redactSecrets, on URL spans that used to shelter too much ──────────────

describe('redactSecrets, on the parts of a URL that are not a path', () => {
  it("redacts the password in a URL's userinfo, which is a credential slot and can never hold a content id", () => {
    // The path exemption is justified by content ids riding in path segments.
    // Nothing justifies it for userinfo, and switching a scheme from redis:// to
    // https:// was all it took to turn a caught secret into a leaked one.
    assert.equal(
      redactSecrets('https://svc:a3f5c9d1e7b2408596cd3fa1b7e0d24c@api.acme.com/v1/sync'),
      'https://svc:[redacted]@api.acme.com/v1/sync',
    )
    assert.equal(
      redactSecrets('redis://default:a3f5c9d1e7b2408596cd3fa1b7e0d24c@cache.acme.io:6379'),
      'redis://default:[redacted]@cache.acme.io:6379',
    )
  })

  it('redacts a credential behind a percent-encoded query or fragment delimiter, since encoding a URL is not a defence', () => {
    // '%3F' and '%23' are what those delimiters look like after a callback URL
    // has been through encodeURIComponent or a log line.
    for (const url of [
      'https://acme.com/cb%3Ftoken%3Da3f5c9d1e7b2408596cd3fa1b7e0d24c',
      'https://acme.com/cb%23access_token%3Da3f5c9d1e7b2408596cd3fa1b7e0d24c',
    ]) {
      assert.ok(!redactSecrets(url).includes('a3f5c9d1e7b2408596cd3fa1b7e0d24c'), `leaked: ${url}`)
    }
  })

  it('does not let a typographic character after a link extend the link over what follows it', () => {
    // The terminator set was a list of ASCII punctuation, so every non-ASCII
    // character read as part of the URL — which is what a rich-text editor or a
    // smart-quote autocorrect produces.
    assert.equal(
      redactSecrets('runbook https://acme.com/ops—a3f5c9d1e7b2408596cd3fa1b7e0d24c'),
      'runbook https://acme.com/ops—[redacted]',
    )
    assert.ok(!redactSecrets('https://acme.com/a“a3f5c9d1e7b2408596cd3fa1b7e0d24c').includes('a3f5c9d1'))
  })
})

// ── redactSecrets, on the links the run rules had no position sense about ──
//
// Dropping '/' from the run class splits a URL path into segments, which is not
// the same as keeping the rule off URL paths: it does nothing when one SEGMENT
// is itself long enough. Every fixture below is a link this product's users
// paste daily, and every one came back mangled — which is the shape of a
// redactor that gets switched off.

describe('redactSecrets, on links whose path segment is as long as a key', () => {
  const untouched = (text: string) => assert.equal(redactSecrets(text), text)

  it('leaves a Google Drive, Docs and Slides link alone, whose file ids are 44 characters', () => {
    untouched('Deck is at https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit')
    untouched('https://docs.google.com/presentation/d/1kL9mNbVcXsAdWeRtYuIoP2qZ8yJhGf3nM7bQ5xT0zRs/edit')
    untouched('https://docs.google.com/spreadsheets/d/1kL9mNbVcXsAdWeRtYuIoP2qZ8yJhGf3nM7bQ5xT0zRs/edit#gid=0')
  })

  it('leaves a Notion page link alone however many words are in the title fused to its id', () => {
    // '-' is in the run class, so a multi-word slug and the 32-hex page id are
    // one run: the hex rule correctly spared the id and the base64 rule then ate
    // the pair. Title length, not anything about the id, was the trigger.
    untouched('Spec lives at https://www.notion.so/acme/Q3-Pipeline-Review-1f2e3a4b5c6d7e8f9a0b1c2d3e4f5a6b')
    untouched('See [Q3 pipeline review](https://www.notion.so/acme/Q3-Pipeline-Review-1f2e3a4b5c6d7e8f9a0b1c2d3e4f5a6b) for context.')
    untouched('https://www.notion.so/acme/Q3-Pipeline-Review-1f2e3a4b5c6d7e8f9a0b1c2d3e4f5a6b?pvs=4')
  })

  it('leaves a Gong and a Zoom share link alone, whose ids sit exactly at the run floor', () => {
    untouched('Gong share: https://us-12345.app.gong.io/share/2wYnP0kFj3XqLm8vRt5cZbH7dNsQ1aUeIoPl9gT4')
    untouched('https://acme.zoom.us/rec/share/9gT4dNsQ1aUeIoPl2wYnP0kFj3XqLm8vRt5cZbH7 (passcode in Slack)')
  })

  it('leaves a legacy-format Slack permalink alone, which the exact-length AWS rule was eating', () => {
    // '.' and '-' are outside that rule's class, so a URL's maximal run is
    // bounded by dots rather than by path depth: 'com/archives/C024BE91L/p172…'
    // is exactly 40 characters, and the link came back as
    // 'https://acme.slack.[redacted]'.
    untouched('https://acme.slack.com/archives/C024BE91L/p1724930415123456')
    untouched('Thread is at https://acme.slack.com/archives/C024BE91L/p1724930415123456 if you need context.')
    untouched('https://acme.slack.com/archives/C024BE91L/p1724930415123456?thread_ts=1724930415.123456')
    for (const channel of ['C7GHR2K4P', 'C0288TVBA', 'CQ1M2N3P4', 'C5J8L2W7X', 'C1H9RESGL']) {
      untouched(`https://acme.slack.com/archives/${channel}/p1724930415123456`)
    }
  })

  it('leaves an inline data: URI alone rather than half-eating a payload into an image that will never decode', () => {
    untouched('Icon: data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==')
    untouched('data:text/plain;charset=utf-8;base64,VGhlIHF1aWNrIGJyb3duIGZveCBqdW1wcyBvdmVyIHRoZSBsYXp5IGRvZw==')
  })

  it('still redacts an unprefixed secret in a query or a fragment, which is the position that actually holds one', () => {
    // The counterweight to the whole block: the path is exempt, the query and
    // the fragment are not, and a secret merely standing near a link never was.
    const key = 'tlbjwGDqF7fKKpV5vz6wVbp45abTt6esfHRyH_L3eB8'
    assert.equal(redactSecrets(`https://acme.com/v1?secret=${key}`), 'https://acme.com/v1?[redacted]')
    assert.equal(redactSecrets(`https://acme.com/cb#access_token=${key}`), 'https://acme.com/cb#[redacted]')
    assert.equal(redactSecrets(`Open https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit with ${key}`),
      'Open https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit with [redacted]')
  })
})

// ── redactSecrets, on abbreviated workspace names ──────────────────────────

describe('redactSecrets, on run names built out of abbreviations', () => {
  const untouched = (text: string) => assert.equal(redactSecrets(text), text)

  it('leaves an abbreviation-and-stamp run name alone, which is what an ops team actually types', () => {
    // Both halves of the name test failed on the same population and for the
    // same reason: abbreviations are short by definition, so their letters never
    // group into long same-case runs, and a stamp like '2026Q3' is neither a
    // word nor a number. Six of seven realistic names collapsed to '[redacted]',
    // taking the title out of the candidate block the assistant answers from.
    untouched('SFDC_Opp-Hygiene_QBR-Prep_2026Q3_v2_JM_final')
    untouched('RevOps_ARR-Rollup_EMEA-ENT_2026Q3_v3_kb_final')
    untouched('CS_QBR-Prep_Bot-v4_2026Q3_NA-ENT_jm_draft2')
    untouched('Jira-REVOPS_Sync-v2_2026Q3_ENT-NA_jm_final_v2')
    untouched('Q3FY26-Pipeline_Hygiene-Sweep_v2_ENT_jm_final')
    untouched('Run: SFDC-Sync_Slack-Digest_2026Q3W35_v2_retry3_ok')
    untouched('Gong-Call_MEDDPICC-Extract_2026Q3_v2_ent_final')
  })

  it('still redacts generated runs, so learning to read abbreviations did not blunt the rule', () => {
    for (const secret of [
      'tlbjwGDqF7fKKpV5vz6wVbp45abTt6esfHRyH_L3eB8',
      'zRm2FxozhzN5v2/BUc8RV9ma7bPajJpDknd64sUZ',
      '4OTUrW6hrzdU1OTZJDyk-ZJKWMZoVwWme-RZImVAwl4',
    ]) {
      assert.equal(redactSecrets(`token ${secret} here`), 'token [redacted] here')
    }
  })
})

// ── redactSecrets, on the word "bearer" in ordinary prose ──────────────────

describe('redactSecrets, on the English word "bearer"', () => {
  it('leaves an English compound after the word bearer alone, however long', () => {
    // '-', '/', '.' and '_' are all inside the token class, so a hyphenated or
    // slashed compound of 20-plus characters was one contiguous match. The
    // damage was silent and semantically inverted: a sentence saying nothing was
    // stored came out as though something had been found and removed.
    for (const text of [
      'Document the Bearer authentication/authorization difference for the integrations page.',
      'Bearer credentials-are-never-stored-here, Nango holds them.',
      'The Bearer instrument-transfer-agreement is filed under legal.',
    ]) {
      assert.equal(redactSecrets(text), text)
    }
  })

  it('still redacts a real bearer token, which is not a sequence of words', () => {
    assert.equal(
      redactSecrets('It returned 401 with Authorization: Bearer EXAMPLEnotarealtoken0000000000 set.'),
      'It returned 401 with Authorization: Bearer [redacted] set.',
    )
    assert.equal(
      redactSecrets('Authorization: Bearer dGhpcy1pcy1hLXRva2VuLXZhbHVlLTEyMzQ1Njc4OTA='),
      'Authorization: Bearer [redacted]',
    )
  })
})

// ── redactSecrets, applied to its own output ──────────────────────────────

describe('redactSecrets, applied twice to a link carrying two ids', () => {
  it('is idempotent, so the false positive the position rule prevents cannot appear only on the second pass', () => {
    // The run rules used to run as whole-text passes AFTER the positional hex
    // pass, so one of them could rewrite a path segment to '[redacted]' — and
    // '[' is not a URL character, so on the next application the URL span
    // stopped there and the content id further along was no longer inside a URL.
    // Invisible to any single-pass test, which is why this one applies it twice.
    for (const input of [
      'https://cdn.acme.com/assets/tlbjwGDqF7fKKpV5vz6wVbp45abTt6esfHRyH_L3eB8/9e107d9d372bb6826bd81d3542a419d6/logo.png',
      'https://api.acme.com/v1/tlbjwGDqF7fKKpV5vz6wVbp45abTt6esfHRyH_L3eB8/objects/9e107d9d372bb6826bd81d3542a419d6',
      'https://a.co/tlbjwGDqF7fKKpV5vz6wVbp45abTt6esfHRyH_L3eB8/9e107d9d372bb6826bd81d3542a419d6',
    ]) {
      assert.equal(redactSecrets(input), input, 'a content id in a path is not a credential on any pass')
      assert.equal(redactSecrets(redactSecrets(input)), redactSecrets(input))
    }
  })

  it('stays idempotent on the shapes it does redact', () => {
    for (const input of [
      'SALESFORCE_CLIENT_SECRET=4OTUrW6hrzdU1OTZJDyk-ZJKWMZoVwWme-RZImVAwl4',
      'https://svc:a3f5c9d1e7b2408596cd3fa1b7e0d24c@api.acme.com/v1/sync',
      'restore from backup_2026_08_29_a3f5c9d1e7b2408596cd3fa1b7e0d24c.sql',
      'https://hooks.acme.com/services/ghp_EXAMPLEnotarealtoken000000000000000A/9e107d9d372bb6826bd81d3542a419d6',
    ]) {
      const once = redactSecrets(input)
      assert.equal(redactSecrets(once), once, `not idempotent: ${input.slice(0, 40)}…`)
    }
  })
})
