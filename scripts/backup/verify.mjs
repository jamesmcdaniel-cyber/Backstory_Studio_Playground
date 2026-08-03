import { spawnSync } from 'node:child_process'

const target = process.env.RESTORE_DATABASE_URL
if (!target) throw new Error('RESTORE_DATABASE_URL must point to a disposable verification database.')
if (process.env.RESTORE_CONFIRM !== 'REPLACE_TARGET_DATABASE') throw new Error('Restore confirmation is required.')
const restore = spawnSync(process.execPath, ['scripts/backup/restore.mjs'], { stdio: 'inherit', env: process.env })
if (restore.status !== 0) process.exit(restore.status ?? 1)
const sql = `
DO $$ BEGIN
  IF to_regclass('public.organizations') IS NULL OR to_regclass('public.flows') IS NULL OR to_regclass('public._prisma_migrations') IS NULL THEN
    RAISE EXCEPTION 'required tables absent after restore';
  END IF;
END $$;
SELECT json_build_object(
  'organizations', (SELECT count(*) FROM organizations),
  'users', (SELECT count(*) FROM users),
  'flows', (SELECT count(*) FROM flows),
  'failedMigrations', (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)
);`
const check = spawnSync('psql', ['--no-psqlrc', '--set', 'ON_ERROR_STOP=1', target, '--command', sql], { stdio: 'inherit' })
if (check.status !== 0) throw new Error('Post-restore integrity verification failed.')
console.log(JSON.stringify({ proof: 'backup-restored-and-queried', verifiedAt: new Date().toISOString() }))
