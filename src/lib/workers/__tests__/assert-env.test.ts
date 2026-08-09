import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { auditWorkerEnv } from '@/lib/workers/assert-env'

const FULL_ENV: Record<string, string> = {
  REDIS_URL: 'rediss://default:secret@example.upstash.io:6379',
  DATABASE_URL: 'postgresql://u:p@db.example.com:5432/app?pgbouncer=true&connection_limit=20',
  ENCRYPTION_KEY: 'k'.repeat(32),
  ANTHROPIC_API_KEY: 'sk-ant-test',
  SENTRY_DSN: 'https://x@sentry.example/1',
  NANGO_SECRET_KEY: 'nango',
  VOYAGE_API_KEY: 'voyage',
  VAPID_PUBLIC_KEY: 'vpub',
  VAPID_PRIVATE_KEY: 'vpriv',
  NEXT_PUBLIC_APP_URL: 'https://app.example.com',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
}

const without = (...keys: string[]) =>
  Object.fromEntries(Object.entries(FULL_ENV).filter(([k]) => !keys.includes(k)))

describe('auditWorkerEnv', () => {
  it('a fully-provisioned env has no findings', () => {
    const audit = auditWorkerEnv(FULL_ENV, 5)
    assert.deepEqual(audit.fatal, [])
    assert.deepEqual(audit.warnings, [])
  })

  it('missing core secrets are fatal', () => {
    const audit = auditWorkerEnv(without('REDIS_URL', 'DATABASE_URL'), 5)
    assert.ok(audit.fatal.some((f) => f.includes('REDIS_URL')))
    assert.ok(audit.fatal.some((f) => f.includes('DATABASE_URL')))
  })

  it('the serverless-shaped DATABASE_URL (connection_limit=1) warns about pool starvation', () => {
    const audit = auditWorkerEnv(
      { ...FULL_ENV, DATABASE_URL: 'postgresql://u:p@db.example.com:6543/app?pgbouncer=true&connection_limit=1' },
      5,
    )
    assert.ok(audit.warnings.some((w) => /connection_limit=1\b/.test(w) && /P2024|pool/i.test(w)))
  })

  it('a connection_limit below the worker fleet demand warns with the needed size', () => {
    // 4 queues × concurrency 5 = 20 concurrent jobs on one Prisma pool.
    const audit = auditWorkerEnv(
      { ...FULL_ENV, DATABASE_URL: 'postgresql://u:p@db.example.com:5432/app?connection_limit=8' },
      5,
    )
    assert.ok(audit.warnings.some((w) => w.includes('20')))
  })

  it('an absent connection_limit param does not warn (Prisma sizes the pool itself)', () => {
    const audit = auditWorkerEnv({ ...FULL_ENV, DATABASE_URL: 'postgresql://u:p@db.example.com:5432/app' }, 5)
    assert.deepEqual(audit.warnings, [])
  })

  it('each missing tool-plane secret warns and names its lost capability', () => {
    const audit = auditWorkerEnv(without('SENTRY_DSN', 'NANGO_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'), 5)
    assert.deepEqual(audit.fatal, [])
    assert.ok(audit.warnings.some((w) => w.includes('SENTRY_DSN')))
    assert.ok(audit.warnings.some((w) => w.includes('NANGO_SECRET_KEY')))
    assert.ok(audit.warnings.some((w) => w.includes('SUPABASE_SERVICE_ROLE_KEY')))
  })
})
