import { test } from 'node:test'
import assert from 'node:assert/strict'
import { whereHasOrgScope, assertOrgScoped, ORG_SCOPED_MODELS } from '../tenant-guard'

test('whereHasOrgScope accepts scope that constrains every matched row', () => {
  assert.equal(whereHasOrgScope({ organizationId: 'x' }), true)
  assert.equal(whereHasOrgScope({ id: '1', organizationId: 'x' }), true)
  assert.equal(whereHasOrgScope({ organizationId: { equals: 'x' } }), true)
  assert.equal(whereHasOrgScope({ organizationId: { in: ['x', 'y'] } }), true)
  assert.equal(whereHasOrgScope({ AND: [{ id: '1' }, { organizationId: 'x' }] }), true)
  assert.equal(whereHasOrgScope({ run: { organizationId: 'x' } }), true) // to-one shorthand
  assert.equal(whereHasOrgScope({ execution: { is: { organizationId: 'x' } } }), true)
  assert.equal(whereHasOrgScope({ id: '1' }), false)
  assert.equal(whereHasOrgScope(undefined), false)
  assert.equal(whereHasOrgScope(null), false)
  assert.equal(whereHasOrgScope({}), false)
})

/**
 * These are the shapes the previous "organizationId appears somewhere" check
 * accepted. Each one matches rows outside the caller's org, which is the leak
 * the guard exists to prevent — so each must now be rejected.
 */
test('an OR branch without org scope is rejected — it widens the match to every org', () => {
  assert.equal(
    whereHasOrgScope({ OR: [{ organizationId: 'x' }, { collaborators: { some: { userId: 'u1' } } }] }),
    false,
  )
})

test('an OR is scoped only when EVERY branch is scoped', () => {
  assert.equal(whereHasOrgScope({ OR: [{ organizationId: 'x', a: 1 }, { organizationId: 'x', b: 2 }] }), true)
  assert.equal(whereHasOrgScope({ OR: [] }), false)
})

test('a negated org scope is never scope — it selects every OTHER org', () => {
  assert.equal(whereHasOrgScope({ NOT: { organizationId: 'x' } }), false)
  assert.equal(whereHasOrgScope({ organizationId: { not: 'x' } }), false)
  assert.equal(whereHasOrgScope({ isActive: true, NOT: { organizationId: 'x' } }), false)
})

test('a to-many relation filter does not scope the matched row', () => {
  // `some` proves a RELATED row is in the org, not that this row is.
  assert.equal(whereHasOrgScope({ runs: { some: { organizationId: 'x' } } }), false)
  // `every` is vacuously true when the relation is empty.
  assert.equal(whereHasOrgScope({ runs: { every: { organizationId: 'x' } } }), false)
  assert.equal(whereHasOrgScope({ runs: { none: { organizationId: 'x' } } }), false)
  assert.equal(whereHasOrgScope({ run: { isNot: { organizationId: 'x' } } }), false)
})

test('scalar filter objects are not mistaken for relation filters', () => {
  assert.equal(whereHasOrgScope({ id: { in: ['a', 'b'] } }), false)
  assert.equal(whereHasOrgScope({ startedAt: { lt: new Date() } }), false)
  assert.equal(whereHasOrgScope({ status: { in: ['pending', 'running'] } }), false)
})

test('a top-level AND carrying scope survives alongside an unscoped OR', () => {
  // The real shape from the snapshot route: org scope at the top, an OR that
  // only narrows further. Narrowing is always safe.
  assert.equal(
    whereHasOrgScope({ organizationId: 'x', OR: [{ userId: 'u1' }, { userId: null }] }),
    true,
  )
})

test('assertOrgScoped throws a descriptive error for unscoped reads on org models', () => {
  assert.throws(
    () => assertOrgScoped('Flow', 'findFirst', { where: { id: 'f1' } }),
    (error: Error) =>
      error.message.includes('Flow.findFirst') &&
      error.message.includes('organizationId') &&
      error.message.includes('systemPrisma'),
  )
})

test('assertOrgScoped passes scoped queries and non-org models', () => {
  assert.doesNotThrow(() => assertOrgScoped('Flow', 'findFirst', { where: { id: 'f1', organizationId: 'o1' } }))
  assert.doesNotThrow(() => assertOrgScoped('WorkflowStep', 'findMany', { where: { executionId: 'e1' } }))
})

test('assertOrgScoped ignores non-where operations and create data', () => {
  assert.doesNotThrow(() => assertOrgScoped('Flow', 'create', { data: { name: 'f', organizationId: 'o1' } }))
})

test('ORG_SCOPED_MODELS covers the known org-carrying models', () => {
  for (const model of ['AgentTask', 'AgentExecution', 'Flow', 'FlowRun', 'Signal', 'Notification', 'AuditEvent', 'McpConnection', 'KnowledgeDocument']) {
    assert.ok(ORG_SCOPED_MODELS.has(model), model)
  }
  assert.ok(!ORG_SCOPED_MODELS.has('User')) // nullable orgId — bootstrap queries are org-less by design
  assert.ok(!ORG_SCOPED_MODELS.has('Organization')) // the tenant row itself
})

test('whereHasOrgScope rejects an undefined organizationId value', () => {
  assert.equal(whereHasOrgScope({ organizationId: undefined }), false)
  assert.equal(whereHasOrgScope({ id: '1', organizationId: undefined }), false)
  assert.equal(whereHasOrgScope({ organizationId: null }), true)
})

test('assertOrgScoped guards upsert and updateManyAndReturn', () => {
  assert.throws(() => assertOrgScoped('Flow', 'upsert', { where: { id: 'f1' } }))
  assert.doesNotThrow(() => assertOrgScoped('Flow', 'upsert', { where: { id: 'f1', organizationId: 'o1' } }))
  assert.throws(() => assertOrgScoped('Flow', 'updateManyAndReturn', { where: { status: 'ACTIVE' } }))
})
