import test from 'node:test'
import assert from 'node:assert/strict'
import { artifactPermissions, editorIdsOf, publicArtifactUrl } from '../sharing'
import type { Permission } from '@/lib/authz/permissions'

const viewer = (userId: string, perms: Permission[]) => ({ userId, can: (p: Permission) => perms.includes(p) })
const MEMBER: Permission[] = ['agent.read', 'agent.write', 'agent.run']
const VIEWER_ROLE: Permission[] = ['agent.read']
const ADMIN: Permission[] = [...MEMBER, 'org.manage']
const artifact = (over: { userId?: string; workspaceAccess?: string; editorIds?: unknown } = {}) => ({ userId: 'owner', workspaceAccess: 'edit', editorIds: [] as unknown, ...over }) as never

test('the owner and admins can always edit and share', () => {
  assert.equal(artifactPermissions(viewer('owner', VIEWER_ROLE), artifact({ workspaceAccess: 'view' })).reason, 'owner')
  assert.equal(artifactPermissions(viewer('admin', ADMIN), artifact({ workspaceAccess: 'view' })).canEdit, true)
})

test('workspace access "edit" keeps today\'s behaviour: members edit, Viewers do not', () => {
  assert.equal(artifactPermissions(viewer('m', MEMBER), artifact()).canEdit, true)
  assert.equal(artifactPermissions(viewer('v', VIEWER_ROLE), artifact()).canEdit, false)
})

test('workspace access "view" locks it to its owner, admins and named editors', () => {
  assert.equal(artifactPermissions(viewer('m', MEMBER), artifact({ workspaceAccess: 'view' })).canEdit, false)
  assert.equal(artifactPermissions(viewer('m', MEMBER), artifact({ workspaceAccess: 'view', editorIds: ['m'] })).reason, 'editor')
})

test('a named editor can edit whatever their role — a Viewer included', () => {
  const p = artifactPermissions(viewer('v', VIEWER_ROLE), artifact({ editorIds: ['v'] }))
  assert.deepEqual([p.canEdit, p.canShare, p.reason], [true, true, 'editor'])
})

test('stored editor lists are read defensively, and public links live under /share/artifact', () => {
  assert.deepEqual(editorIdsOf(['a', 3, '', null, 'b']), ['a', 'b'])
  assert.deepEqual(editorIdsOf('nope'), [])
  assert.equal(publicArtifactUrl('https://app.example/', 'tok'), 'https://app.example/share/artifact/tok')
})
