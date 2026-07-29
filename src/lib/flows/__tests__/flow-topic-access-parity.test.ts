import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveFlowRole } from '../access'

const sql = readFileSync(
  fileURLToPath(new URL('../../../../prisma/migrations/20260729120000_flow_jam_rls/migration.sql', import.meta.url)),
  'utf8',
)

test('the SQL encodes the same precedence as resolveFlowRole', () => {
  // 1. Owner wins outright.
  assert.match(sql, /v_owner is not null and v_owner = v_user_id[\s\S]{0,80}return 'edit'/)
  // 2. Same org: private is invisible; view is view unless the row is ownerless.
  assert.match(sql, /v_visibility = 'private'[\s\S]{0,60}return null/)
  assert.match(sql, /v_visibility = 'view'[\s\S]{0,120}when v_owner is null then 'edit' else 'view' end/)
  // 3. Cross-org falls back to an accepted collaborator row.
  assert.match(sql, /from public\.flow_collaborators[\s\S]{0,200}return v_role/)
  // 4. Everything else is invisible.
  assert.match(sql, /return null;\s*end;/)
})

test('the TypeScript boundary it mirrors still behaves that way', () => {
  const viewer = { userId: 'u1', organizationId: 'org1' }
  const base = { organizationId: 'org1', userId: 'owner', visibility: 'shared' }
  assert.equal(resolveFlowRole({ ...base, userId: 'u1' }, viewer), 'edit', 'owner')
  assert.equal(resolveFlowRole({ ...base, visibility: 'private' }, viewer), null, 'same-org private')
  assert.equal(resolveFlowRole({ ...base, visibility: 'view' }, viewer), 'view', 'same-org view')
  assert.equal(resolveFlowRole({ ...base, visibility: 'view', userId: null }, viewer), 'edit', 'ownerless view')
  assert.equal(resolveFlowRole({ ...base, organizationId: 'org2' }, viewer), null, 'cross-org, no grant')
  assert.equal(
    resolveFlowRole({ ...base, organizationId: 'org2', collaboratorRole: 'view' }, viewer),
    'view',
    'cross-org collaborator',
  )
})

test('both topics are policed, and only editors may write ops', () => {
  assert.match(sql, /create policy "flow_jam_read"[\s\S]{0,200}for select/)
  assert.match(sql, /create policy "flow_jam_write"[\s\S]{0,200}for insert/)
  assert.match(sql, /like '%:ops' then public\.flow_topic_access\(realtime\.topic\(\)\) = 'edit'/)
})

test('a share token alone never authorizes the channel — it is redeemed over HTTP first', () => {
  assert.doesNotMatch(sql, /shareToken/)
})

test('the hand-appliable fallback stays identical to the migration', () => {
  const fallback = readFileSync(fileURLToPath(new URL('../../../../supabase/flow-jam-rls.sql', import.meta.url)), 'utf8')
  assert.equal(fallback.trim(), sql.trim())
})
