import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildInviteLink } from '../invite-link'

test('buildInviteLink points at the invite page and carries a safe next path', () => {
  assert.equal(buildInviteLink('https://app.test', 'tok'), 'https://app.test/invite/tok')
  assert.equal(
    buildInviteLink('https://app.test', 'tok', '/flows/f1'),
    'https://app.test/invite/tok?next=%2Fflows%2Ff1',
  )
})

test('buildInviteLink drops an unsafe next instead of forwarding it', () => {
  assert.equal(buildInviteLink('https://app.test', 'tok', '//evil.example.com'), 'https://app.test/invite/tok')
  assert.equal(buildInviteLink('https://app.test', 'tok', 'https://evil.example.com'), 'https://app.test/invite/tok')
})

test('buildInviteLink normalizes a trailing slash on the base', () => {
  assert.equal(buildInviteLink('https://app.test/', 'tok'), 'https://app.test/invite/tok')
})
