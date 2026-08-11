import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen } from '@testing-library/react'
import { act } from 'react'
import { MembersSection } from '@/components/settings/members-section'
import {
  invitePayload,
  isSuperAdminPlatformRole,
  memberRoleOption,
  memberRolePatch,
  workspaceRoleFor,
} from '@/lib/authz/platform-roles'

/**
 * Super admin as the top rank of the Members role select.
 *
 * The mapping is the interesting part: it is one control over TWO stored
 * columns, so the failures worth pinning are a rank that renders as the wrong
 * label, and a rank change that writes a column it had no business touching.
 */

const flush = async () => { await act(async () => { await Promise.resolve() }) }

type Row = { id: string; name: string; email: string; role: string; platformRole?: string | null }

/** Stub the roster + invitations the section loads on mount. */
function stub(members: Row[]) {
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes('/invitations')) return { ok: true, json: async () => ({ success: true, invitations: [] }) }
    return { ok: true, json: async () => ({ success: true, selfId: 'me', members }) }
  }) as unknown as typeof fetch
}

const baseProps = { canManage: true, selfId: 'me' }

test('the rank mapping reads both stored columns', () => {
  assert.equal(memberRoleOption('ADMIN', 'reviewer'), 'SUPER_ADMIN')
  assert.equal(memberRoleOption('ADMIN', 'staff'), 'ADMIN', 'the staff marker is not super admin')
  assert.equal(memberRoleOption('VIEWER', null), 'VIEWER')
  // The owner outranks the platform tier and keeps its own label.
  assert.equal(memberRoleOption('OWNER', 'reviewer'), 'OWNER')
  assert.equal(workspaceRoleFor('SUPER_ADMIN'), 'ADMIN', 'a super admin administers their workspace')
  assert.ok(!isSuperAdminPlatformRole('staff'))
})

test('Super admin is offered above Admin, and only to a caller who holds it', async () => {
  stub([{ id: 'them', name: 'Them', email: 'them@x.test', role: 'USER' }])
  render(<MembersSection {...baseProps} canManageSuperAdmins />)
  await flush()
  const options = screen.getAllByRole('option', { hidden: true }).map((node) => node.textContent)
  assert.equal(options[0], 'Super admin', `expected Super admin first, got ${JSON.stringify(options)}`)
  assert.ok(options.includes('Admin'))
  cleanup()

  stub([{ id: 'them', name: 'Them', email: 'them@x.test', role: 'USER' }])
  render(<MembersSection {...baseProps} canManageSuperAdmins={false} />)
  await flush()
  assert.equal(screen.queryAllByRole('option', { hidden: true }).filter((n) => n.textContent === 'Super admin').length, 0)
  cleanup()
})

test('an existing super admin still reads as one to a caller who cannot grant it', async () => {
  // Without this the select holds a value with no matching option, and the row
  // silently reads as Admin — the exact bug Viewer had before it was listed.
  stub([{ id: 'them', name: 'Them', email: 'them@x.test', role: 'ADMIN', platformRole: 'reviewer' }])
  render(<MembersSection {...baseProps} canManageSuperAdmins={false} />)
  await flush()
  assert.ok(screen.getByText('Super admin'), 'the rank is still shown')
  cleanup()
})

test('the platform column is written only when the rank actually flips', () => {
  // An ordinary change must not carry platformRole at all: sending null here
  // would strip the separate 'staff' employee marker off whoever holds it.
  assert.deepEqual(memberRolePatch('VIEWER', 'staff'), { role: 'VIEWER' })
  assert.deepEqual(memberRolePatch('ADMIN', null), { role: 'ADMIN' })
  // Promotion and demotion both flip the rank, so both send both columns.
  assert.deepEqual(memberRolePatch('SUPER_ADMIN', null), { role: 'ADMIN', platformRole: 'reviewer' })
  assert.deepEqual(memberRolePatch('USER', 'reviewer'), { role: 'USER', platformRole: null })
  // Re-picking the rank someone already holds is a no-op on the platform side.
  assert.deepEqual(memberRolePatch('SUPER_ADMIN', 'reviewer'), { role: 'ADMIN' })
})

test('inviting a super admin sends the workspace role and the grant together', () => {
  assert.deepEqual(invitePayload('new@x.test', 'SUPER_ADMIN'), {
    email: 'new@x.test',
    role: 'ADMIN',
    platformRole: 'reviewer',
  })
  assert.deepEqual(invitePayload('new@x.test', 'VIEWER'), { email: 'new@x.test', role: 'VIEWER' })
})
