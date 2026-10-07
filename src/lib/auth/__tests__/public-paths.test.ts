import test from 'node:test'
import assert from 'node:assert/strict'
import { isPublicPath, guardsSignedOut } from '@/lib/auth/public-paths'

test('links anyone may open signed out are public: shared artifacts and flows, invitations, forms', () => {
  for (const path of ['/', '/privacy', '/terms', '/auth/login', '/share/artifact/abc123', '/share/flow/abc123', '/invite/abc123', '/forms/abc123']) {
    assert.equal(isPublicPath(path), true, path)
  }
  for (const path of ['/dashboard', '/artifacts/abc123', '/flows/abc123', '/sharepoint', '/invites']) {
    assert.equal(isPublicPath(path), false, path)
  }
})

test('the signed-out guard never bounces a visitor off a public link — refreshing or refocusing a shared page keeps them on it', () => {
  for (const path of ['/share/artifact/abc123', '/share/flow/abc123', '/invite/abc123', '/forms/abc123', '/', '/auth/login', '/auth/mfa']) {
    assert.equal(guardsSignedOut(path), false, path)
  }
  for (const path of ['/dashboard', '/artifacts/abc123', '/flows/abc123']) {
    assert.equal(guardsSignedOut(path), true, path)
  }
})
