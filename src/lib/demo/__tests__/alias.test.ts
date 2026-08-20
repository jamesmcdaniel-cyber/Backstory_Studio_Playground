import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAliasBook } from '../alias'

const ORG = 'org-1111'

test('same org + same input → same alias, across separate books', () => {
  const a = createAliasBook(ORG).company('Acme Corp')
  const b = createAliasBook(ORG).company('Acme Corp')
  assert.deepEqual(a, b)
})

test('different orgs alias the same company differently', () => {
  const a = createAliasBook(ORG).company('Acme Corp')
  const b = createAliasBook('org-2222').company('Acme Corp')
  assert.notEqual(a.name, b.name)
})

test('company alias never contains the real name, and gets a matching domain', () => {
  const book = createAliasBook(ORG)
  const alias = book.company('Acme Corp')
  assert.ok(!alias.name.toLowerCase().includes('acme'))
  assert.match(alias.domain, /^[a-z0-9-]+\.[a-z]+$/)
  // domain derives from the alias name, not the real one
  assert.ok(!alias.domain.includes('acme'))
})

test('normalisation: case and whitespace variants collapse to one alias', () => {
  const book = createAliasBook(ORG)
  assert.deepEqual(book.company('Acme Corp'), book.company('  acme  corp '))
})

test('people land on their company alias domain with a fictional name', () => {
  const book = createAliasBook(ORG)
  const company = book.company('Acme Corp')
  const person = book.person({ name: 'Sarah Chen', email: 'sarah.chen@acme.com', companyName: 'Acme Corp' })
  assert.ok(person.email)
  assert.ok(person.email.endsWith(`@${company.domain}`))
  assert.ok(!person.name.toLowerCase().includes('sarah'))
  assert.ok(!person.name.toLowerCase().includes('chen'))
  assert.ok(person.title.length > 0)
})

test('a person with no email keeps a null email', () => {
  const book = createAliasBook(ORG)
  const person = book.person({ name: 'Sam Ortiz', email: null, companyName: null })
  assert.equal(person.email, null)
  assert.ok(person.name.length > 0)
})

test('a person with no company gets an email on a generated personal domain', () => {
  const book = createAliasBook(ORG)
  const person = book.person({ name: 'Sam Ortiz', email: 'sam@gmail.com', companyName: null })
  assert.ok(person.email)
  assert.ok(!person.email.includes('sam@gmail.com'))
  assert.ok(person.email.includes('@'))
})

test('phones, addresses, ips, ids are deterministic and never the input', () => {
  const book = createAliasBook(ORG)
  for (const [method, input] of [
    ['phone', '+1 (415) 555-2671'],
    ['streetAddress', '742 Evergreen Terrace'],
    ['ip', '10.1.2.3'],
    ['nationalId', '123-45-6789'],
    ['cardNumber', '4111 1111 1111 1111'],
  ] as const) {
    const out = book[method](input)
    assert.notEqual(out, input)
    assert.equal(out, createAliasBook(ORG)[method](input))
  }
})

test('generated ips stay in TEST-NET space', () => {
  assert.match(createAliasBook(ORG).ip('10.1.2.3'), /^203\.0\.113\.\d{1,3}$/)
})

test('logo data URL is an inline SVG', () => {
  const url = createAliasBook(ORG).logoDataUrl('Northwind Traders')
  assert.ok(url.startsWith('data:image/svg+xml'))
})

test('aka() registers an extra spelling for the sweep', () => {
  const book = createAliasBook(ORG)
  const company = book.company('globex')
  book.aka('globex.com', company.domain)
  assert.equal(book.entries().get('globex.com'), company.domain)
})

test('entries() records every real→alias mapping made', () => {
  const book = createAliasBook(ORG)
  const company = book.company('Acme Corp')
  const person = book.person({ name: 'Sarah Chen', email: 'sarah.chen@acme.com', companyName: 'Acme Corp' })
  const entries = book.entries()
  assert.equal(entries.get('acme corp'), company.name)
  assert.equal(entries.get('sarah chen'), person.name)
  assert.equal(entries.get('sarah.chen@acme.com'), person.email)
})
