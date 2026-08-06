import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDecisionEmail } from '../decision-email'
import { DEFAULT_PLATFORM_STAFF_EMAILS, normalizeStaffEmail, staffBootstrapAllowlist } from '../staff-emails'

const APP = 'https://app.example.com'

test('an approval says published and links to the catalogue', () => {
  const email = buildDecisionEmail({ decision: 'approved', title: 'Pipeline digest', appUrl: APP })
  assert.equal(email.subject, '"Pipeline digest" is now in the catalogue')
  assert.match(email.html, /approved and is now published/)
  assert.match(email.html, new RegExp(`${APP}/templates`))
  assert.match(email.text, /approved and is now published/)
})

test('a rejection carries the reviewer note in html and text', () => {
  const email = buildDecisionEmail({
    decision: 'rejected',
    title: 'Pipeline digest',
    note: 'Duplicates an existing template.',
    appUrl: APP,
  })
  assert.equal(email.subject, '"Pipeline digest" was not accepted to the catalogue')
  assert.match(email.html, /Duplicates an existing template\./)
  assert.match(email.text, /Reviewer's note:\nDuplicates an existing template\./)
})

test('changes_requested has its own subject and includes the note', () => {
  const email = buildDecisionEmail({
    decision: 'changes_requested',
    title: 'Pipeline digest',
    note: 'Add a setup step.',
    appUrl: APP,
  })
  assert.match(email.subject, /needs changes before it can be published/)
  assert.match(email.html, /Add a setup step\./)
})

test('reviewer notes are HTML-escaped, not injected', () => {
  const email = buildDecisionEmail({
    decision: 'rejected',
    title: 'Digest <img src=x>',
    note: '<script>alert(1)</script>',
    appUrl: APP,
  })
  assert.ok(!email.html.includes('<script>'))
  assert.match(email.html, /&lt;script&gt;/)
  assert.match(email.html, /Digest &lt;img src=x&gt;/)
})

test('the bootstrap allowlist always contains the platform admin and unions the env', () => {
  const original = process.env.PLATFORM_STAFF_EMAILS
  process.env.PLATFORM_STAFF_EMAILS = ' Extra@People.AI , '
  try {
    const allowlist = staffBootstrapAllowlist()
    for (const email of DEFAULT_PLATFORM_STAFF_EMAILS) assert.ok(allowlist.has(email))
    assert.ok(allowlist.has('extra@people.ai'))
  } finally {
    if (original === undefined) delete process.env.PLATFORM_STAFF_EMAILS
    else process.env.PLATFORM_STAFF_EMAILS = original
  }
})

test('normalizeStaffEmail lowercases, trims, and nulls out empties', () => {
  assert.equal(normalizeStaffEmail('  Jane@People.AI '), 'jane@people.ai')
  assert.equal(normalizeStaffEmail('   '), null)
  assert.equal(normalizeStaffEmail(undefined), null)
})
