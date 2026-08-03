import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { envAllowedDomains, envAllowsEmail } from '@/lib/auth/allowed-domain'

const prior = process.env.ALLOWED_EMAIL_DOMAINS

afterEach(() => {
  if (prior === undefined) delete process.env.ALLOWED_EMAIL_DOMAINS
  else process.env.ALLOWED_EMAIL_DOMAINS = prior
})

describe('envAllowedDomains', () => {
  test('parses a comma-separated list, normalizing each entry', () => {
    process.env.ALLOWED_EMAIL_DOMAINS = ' Customer.COM , @partner.io '
    assert.deepEqual(envAllowedDomains(), ['customer.com', 'partner.io'])
  })

  test('is empty when unset, so the gate is unchanged by default', () => {
    delete process.env.ALLOWED_EMAIL_DOMAINS
    assert.deepEqual(envAllowedDomains(), [])
  })

  test('drops public email providers — the highest-consequence misconfiguration', () => {
    process.env.ALLOWED_EMAIL_DOMAINS = 'customer.com,gmail.com,outlook.com'
    assert.deepEqual(envAllowedDomains(), ['customer.com'])
  })

  test('drops malformed entries rather than admitting them', () => {
    process.env.ALLOWED_EMAIL_DOMAINS = '*.customer.com,person@customer.com,nodot,,good.com'
    assert.deepEqual(envAllowedDomains(), ['good.com'])
  })
})

describe('envAllowsEmail', () => {
  test('admits an exact domain match only', () => {
    process.env.ALLOWED_EMAIL_DOMAINS = 'customer.com'
    assert.equal(envAllowsEmail('person@customer.com'), true)
    assert.equal(envAllowsEmail('PERSON@Customer.com'), true)
    // Lookalike suffix must not pass.
    assert.equal(envAllowsEmail('person@customer.com.attacker.tld'), false)
    assert.equal(envAllowsEmail('person@notcustomer.com'), false)
  })

  test('refuses everything when unset', () => {
    delete process.env.ALLOWED_EMAIL_DOMAINS
    assert.equal(envAllowsEmail('person@customer.com'), false)
  })

  test('refuses a null or malformed email', () => {
    process.env.ALLOWED_EMAIL_DOMAINS = 'customer.com'
    assert.equal(envAllowsEmail(null), false)
    assert.equal(envAllowsEmail('not-an-email'), false)
  })
})
