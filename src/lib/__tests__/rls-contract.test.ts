import test from 'node:test'
import assert from 'node:assert/strict'
import { exactOrganizationId } from '@/lib/tenant-database-context'

test('RLS context accepts exactly one tenant and rejects ambiguity', () => {
  assert.equal(exactOrganizationId({ where: { organizationId: 'one' } }), 'one')
  assert.equal(exactOrganizationId({ data: { organizationId: 'one' }, where: { organizationId: { equals: 'one' } } }), 'one')
  assert.equal(exactOrganizationId({ OR: [{ organizationId: 'one' }, { organizationId: 'two' }] }), null)
  assert.equal(exactOrganizationId({ where: { id: 'row' } }), null)
})
