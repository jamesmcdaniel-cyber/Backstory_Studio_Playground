import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { visibleNotificationScope, unreadNotificationScope } from '../scope'

describe('visibleNotificationScope', () => {
  test('shows the person their own notifications and the workspace-wide ones', () => {
    const where = visibleNotificationScope('org-1', 'user-1', null)
    assert.equal(where.organizationId, 'org-1')
    assert.deepEqual(where.OR, [{ userId: 'user-1' }, { userId: null }])
    assert.equal('createdAt' in where, false, 'nothing is hidden until they clear')
  })

  test('a clear watermark hides everything that existed when they cleared', () => {
    const clearedAt = new Date('2026-08-24T10:00:00.000Z')
    const where = visibleNotificationScope('org-1', 'user-1', clearedAt)
    assert.deepEqual(where.createdAt, { gt: clearedAt })
  })

  test('the watermark is per person — a workspace-wide notification stays for everyone else', () => {
    // Clearing writes a stamp on the reader, never on the notification, so one
    // person emptying their bell cannot empty a colleague's.
    const mine = visibleNotificationScope('org-1', 'me', new Date('2026-08-24T10:00:00.000Z'))
    const theirs = visibleNotificationScope('org-1', 'them', null)
    assert.ok(mine.createdAt)
    assert.equal('createdAt' in theirs, false)
  })

  test('unread narrows the same scope rather than building a second one', () => {
    const clearedAt = new Date('2026-08-24T10:00:00.000Z')
    const where = unreadNotificationScope('org-1', 'user-1', clearedAt)
    assert.equal(where.readAt, null)
    assert.deepEqual(where.createdAt, { gt: clearedAt })
    assert.deepEqual(where.OR, [{ userId: 'user-1' }, { userId: null }])
  })
})
