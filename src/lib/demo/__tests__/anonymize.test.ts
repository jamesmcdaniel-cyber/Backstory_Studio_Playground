import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAliasBook } from '../alias'
import { anonymizeJson, anonymizeText } from '../anonymize'

const ORG = 'org-1111'

function seededBook() {
  const book = createAliasBook(ORG)
  const company = book.company('Acme Corp')
  const person = book.person({ name: 'Sarah Chen', email: 'sarah.chen@acme.com', companyName: 'Acme Corp' })
  return { book, company, person }
}

test('known names are replaced everywhere in prose, including possessives', () => {
  const { book, company, person } = seededBook()
  const out = anonymizeText(
    "Talked to Sarah Chen about Acme Corp's renewal. Acme Corp is ready; email sarah.chen@acme.com.",
    book,
  )
  assert.ok(!out.includes('Sarah Chen'))
  assert.ok(!out.includes('Acme Corp'))
  assert.ok(!out.includes('sarah.chen@acme.com'))
  assert.ok(out.includes(company.name))
  assert.ok(out.includes(person.name))
})

test('replacement is case-insensitive', () => {
  const { book, company } = seededBook()
  const out = anonymizeText('ACME CORP signed. acme corp is live.', book)
  assert.ok(!/acme/i.test(out))
  assert.ok(out.includes(company.name))
})

test('longest entry wins over its substring', () => {
  const book = createAliasBook(ORG)
  const long = book.company('Acme Corp International')
  book.company('Acme Corp')
  const out = anonymizeText('Meeting with Acme Corp International today.', book)
  assert.ok(out.includes(long.name))
})

test('an email the book never saw is still rewritten by the detector sweep', () => {
  const { book } = seededBook()
  const out = anonymizeText('Loop in bob.jones@globex.com when ready.', book)
  assert.ok(!out.includes('bob.jones@globex.com'))
  assert.match(out, /@/)
})

test('phones, SSNs and street addresses the book never saw are swept', () => {
  const { book } = seededBook()
  const out = anonymizeText('Call 415-555-2671, SSN 123-45-6789, at 742 Maple Street.', book)
  assert.ok(!out.includes('415-555-2671'))
  assert.ok(!out.includes('123-45-6789'))
  assert.ok(!out.includes('742 Maple Street'))
})

test('running the anonymiser twice changes nothing further', () => {
  const { book } = seededBook()
  const once = anonymizeText('Sarah Chen of Acme Corp, reach at sarah.chen@acme.com or 415-555-2671.', book)
  assert.equal(anonymizeText(once, book), once)
})

test('anonymizeJson walks nested structures and leaves keys/non-strings alone', () => {
  const { book, company } = seededBook()
  const out = anonymizeJson(
    { steps: [{ note: 'Ping Acme Corp', count: 3, done: true }], meta: { owner: 'Sarah Chen' } },
    book,
  ) as { steps: { note: string; count: number; done: boolean }[]; meta: { owner: string } }
  assert.ok(out.steps[0].note.includes(company.name))
  assert.equal(out.steps[0].count, 3)
  assert.equal(out.steps[0].done, true)
  assert.ok(!out.meta.owner.includes('Sarah'))
})
