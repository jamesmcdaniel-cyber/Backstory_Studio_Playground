// Applies pending Prisma migrations during the build — but ONLY on production
// deploys (VERCEL_ENV=production). Preview builds and local `npm run build` skip
// it, so a branch's new migration never touches the prod DB before it merges.
//
// Requires DIRECT_URL to reach a migration-capable connection. On Supabase +
// Vercel that MUST be the session pooler (aws-<n>-<region>.pooler.supabase.com
// :5432, IPv4) — the direct db.<ref>.supabase.co host is IPv6-only and
// unreachable from Vercel's build runners.
import { execSync } from 'node:child_process'

const env = process.env.VERCEL_ENV ?? 'local'
if (env === 'production') {
  console.log('▸ production deploy — applying migrations (prisma migrate deploy)')
  try {
    execSync('prisma migrate deploy', { stdio: 'pipe', encoding: 'utf8' })
  } catch (err) {
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`
    process.stdout.write(output)
    // P3009: a previously failed migration is recorded in _prisma_migrations,
    // and Prisma refuses to apply anything until an operator resolves it.
    // Re-deploying cannot fix this — surface the remediation instead of a stack
    // trace. Full procedure: docs/runbooks/deploy.md.
    const failed = output.match(/The `(\S+)` migration started at .* failed/)
    if (output.includes('P3009')) {
      const name = failed?.[1] ?? '<migration-name-from-log-above>'
      console.error(
        [
          '',
          '━'.repeat(72),
          '✖ P3009 — a failed migration is blocking all deploys.',
          '',
          '  Prisma will not retry a failed migration on its own. To re-run it',
          '  (the migration SQL must be idempotent / fixed first):',
          '',
          `    npx prisma migrate resolve --rolled-back ${name}`,
          '',
          '  run against the production DIRECT_URL (session pooler, port 5432),',
          '  then redeploy. If the migration actually completed and only the',
          '  record is stale, use --applied instead. See docs/runbooks/deploy.md.',
          '━'.repeat(72),
        ].join('\n'),
      )
    }
    process.exit(err.status ?? 1)
  }
} else {
  console.log(`▸ skipping migrations (VERCEL_ENV=${env})`)
}
