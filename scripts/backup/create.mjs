import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, resolve } from 'node:path'

const databaseUrl = process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL
if (!databaseUrl) throw new Error('SYSTEM_DATABASE_URL or DATABASE_URL is required.')
const dir = resolve(process.env.BACKUP_DIR ?? 'backups')
mkdirSync(dir, { recursive: true, mode: 0o700 })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const file = resolve(dir, `backstory-${stamp}.dump`)
const result = spawnSync('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', file, databaseUrl], { stdio: 'inherit' })
if (result.status !== 0) throw new Error(`pg_dump failed with status ${result.status}.`)
const digest = createHash('sha256').update(readFileSync(file)).digest('hex')
const manifest = { format: 'backstory.pg-backup.v1', createdAt: new Date().toISOString(), file: basename(file), sha256: digest }
writeFileSync(`${file}.json`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify(manifest))
