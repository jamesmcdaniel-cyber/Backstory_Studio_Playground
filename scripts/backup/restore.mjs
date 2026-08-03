import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const file = resolve(process.env.BACKUP_FILE ?? '')
const target = process.env.RESTORE_DATABASE_URL
if (!process.env.BACKUP_FILE || !target) throw new Error('BACKUP_FILE and RESTORE_DATABASE_URL are required.')
if (process.env.RESTORE_CONFIRM !== 'REPLACE_TARGET_DATABASE') throw new Error('Set RESTORE_CONFIRM=REPLACE_TARGET_DATABASE after verifying the disposable target URL.')
const manifest = JSON.parse(readFileSync(`${file}.json`, 'utf8'))
const digest = createHash('sha256').update(readFileSync(file)).digest('hex')
if (digest !== manifest.sha256) throw new Error('Backup checksum mismatch; restore aborted.')
const restored = spawnSync('pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-acl', '--exit-on-error', '--dbname', target, file], { stdio: 'inherit' })
if (restored.status !== 0) throw new Error(`pg_restore failed with status ${restored.status}.`)
console.log(JSON.stringify({ restoredAt: new Date().toISOString(), sha256: digest }))
