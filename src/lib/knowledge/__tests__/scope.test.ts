import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentScopeSql, agentScopeWhere } from '../scope'

const ORG = '00000000-0000-0000-0000-000000000001'

test('the SQL predicate covers direct, org-wide and collection attachment', () => {
  const sql = agentScopeSql(ORG, 'agent_1').sql
  assert.ok(sql.includes('"agentId"'))
  assert.ok(sql.includes('IS NULL'))
  assert.ok(sql.includes('agent_knowledge_collections'))
  assert.ok(sql.includes('knowledge_document_collections'))
})

test('the SQL predicate parameterizes rather than interpolating its inputs', () => {
  const fragment = agentScopeSql(ORG, "agent'; DROP TABLE x;--")
  assert.equal(fragment.sql.includes('DROP TABLE'), false, 'values must travel as bind parameters')
  assert.ok(fragment.values.includes("agent'; DROP TABLE x;--"))
})

test('the Prisma predicate offers the same three branches', () => {
  const where = agentScopeWhere(ORG, 'agent_1')
  assert.equal(where.OR?.length, 3)
})
