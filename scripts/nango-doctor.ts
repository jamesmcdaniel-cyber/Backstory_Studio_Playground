/**
 * Read-only Nango doctor. Calls listIntegrations() against YOUR Nango
 * environment and cross-checks each enabled integration's unique_key against
 * the code's provider config keys — the one string that links the dashboard
 * catalog to the agent tool registry. Never prints the key.
 *
 * Key resolution, in order: --key=<secret> argv, NANGO_SECRET_KEY in the
 * process env, then .env.local. The argv/env paths exist so a key held in
 * Vercel can be verified WITHOUT first writing it into .env.local — which
 * matters after a Nango account is re-created under a new key.
 *
 * Host: --host=<url> or NANGO_HOST, else .env.local, else US Nango Cloud.
 */
import { readFileSync } from 'node:fs'
import { Nango } from '@nangohq/node'
import { PROVIDER_CONFIG_KEYS } from '../src/lib/nango/provider-config-keys'

const KEY_TO_PROVIDER = new Map<string, string>()
for (const [p, keys] of Object.entries(PROVIDER_CONFIG_KEYS)) for (const k of keys) KEY_TO_PROVIDER.set(k, p)

// --- Load .env.local, collecting ALL values per key (to catch duplicates) ---
function loadEnvLocalMulti(path: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  let raw = ''
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return out
  }
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    ;(out[m[1]] ??= []).push(v)
  }
  return out
}

/**
 * Ask Nango directly why a key was rejected. The SDK surfaces only a status
 * code, and the status alone is actively misleading here: a 403 from a
 * correctly-formed key in the right region means the key is a SCOPED API key
 * missing a scope, which no amount of checking the region or Dev-vs-Prod will
 * reveal. Nango says so precisely in the response body — so read it.
 */
async function diagnose(secretKey: string, host?: string): Promise<string | undefined> {
  try {
    const base = (host || 'https://api.nango.dev').replace(/\/$/, '')
    const res = await fetch(`${base}/integrations`, { headers: { authorization: `Bearer ${secretKey}` } })
    const body: any = await res.json().catch(() => undefined)
    const err = body?.error
    if (!err) return undefined
    return [err.code, err.message].filter(Boolean).join(': ')
  } catch {
    return undefined
  }
}

/** Try a key against Nango. Returns the integration configs, or null + status. */
async function tryKey(secretKey: string, host?: string) {
  try {
    const nango = new Nango({ secretKey, ...(host ? { host } : {}) })
    const { configs } = await nango.listIntegrations()
    return { ok: true as const, configs }
  } catch (e: any) {
    const status = e?.response?.status as number | undefined
    return { ok: false as const, status, message: e?.message ?? String(e), detail: await diagnose(secretKey, host) }
  }
}

/** Read `--flag=value` from argv. */
function argvFlag(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3).trim() || undefined : undefined
}

async function main() {
  const envLocalPath = new URL('../.env.local', import.meta.url).pathname
  const env = loadEnvLocalMulti(envLocalPath)

  // Explicit argv/env beats .env.local: after the Nango account was re-created
  // under a new key, .env.local still holds the DEAD one, and the whole point
  // of this run is to test the new key before committing it anywhere.
  const argvKey = argvFlag('key')
  const host = argvFlag('host') || process.env.NANGO_HOST || env.NANGO_HOST?.[0]

  // Nango split its single environment secret into an API key (scoped, for API
  // calls) and a webhook signing key. NANGO_API_KEY is the current name;
  // NANGO_SECRET_KEY is the legacy single secret that did both jobs.
  const envKeys = [...(env.NANGO_API_KEY ?? []), ...(env.NANGO_SECRET_KEY ?? [])]
  let source: string
  let rawKeys: string[]
  if (argvKey) {
    source = '--key argv'
    rawKeys = [argvKey]
  } else if (process.env.NANGO_API_KEY || process.env.NANGO_SECRET_KEY) {
    source = process.env.NANGO_API_KEY ? 'NANGO_API_KEY env var' : 'NANGO_SECRET_KEY env var'
    rawKeys = [(process.env.NANGO_API_KEY || process.env.NANGO_SECRET_KEY) as string]
  } else {
    source = '.env.local'
    rawKeys = envKeys
  }
  // Distinct values, order preserved.
  const keys = [...new Set(rawKeys.filter(Boolean))]

  if (keys.length === 0) {
    console.log('❌ No Nango API key found (NANGO_API_KEY, or legacy NANGO_SECRET_KEY).')
    console.log('   Pass one without persisting it:  npm run nango:doctor -- --key=<secret>')
    console.log('   ...or set NANGO_API_KEY in the environment, or in .env.local.')
    process.exit(1)
  }
  if (rawKeys.length > 1) {
    console.log(`⚠️  The API key is set ${rawKeys.length}× in .env.local (${keys.length} distinct value(s)) — remove the duplicate; the loader's choice is ambiguous.`)
  }
  console.log(`Key source: ${source}`)
  console.log(`Testing ${keys.length} distinct key value(s)${host ? ` against host=${host}` : ' against US Nango Cloud (api.nango.dev)'}…\n`)

  let configs: Array<{ unique_key: string; provider: string }> | null = null
  let scopeProblem = false
  for (let i = 0; i < keys.length; i++) {
    const label = `key #${i + 1} (${keys[i].length} chars)`
    const res = await tryKey(keys[i], host)
    if (res.ok) {
      console.log(`   ✅ ${label}: authenticated`)
      configs = res.configs
      break
    }
    console.log(`   ❌ ${label}: HTTP ${res.status ?? '?'}${res.status === 401 ? ' (not authorized for this environment)' : ''}`)
    if (res.detail) {
      console.log(`      ↳ Nango says: ${res.detail}`)
      if (/insufficient scope/i.test(res.detail)) scopeProblem = true
    }
  }

  if (!configs) {
    if (scopeProblem) {
      // The key is real and in the right environment — it just isn't the right
      // KIND of key. This is its own failure mode and the generic checklist
      // below sends you looking in all the wrong places.
      console.log('\n❌ The key authenticates but lacks the scopes this app needs.')
      console.log('   That means it is a SCOPED API key, not the environment secret key.')
      console.log('   The app needs, at minimum:')
      console.log('     • environment:integrations:list  — the integrations grid (listIntegrations)')
      console.log('     • environment:connections:list   — the connection mirror (listConnections)')
      console.log('   Scopes alone are not enough, though: the Nango webhook is signed with the')
      console.log('   ENVIRONMENT SECRET KEY, and /api/nango/webhook verifies the HMAC with this')
      console.log('   same value — so a scoped key fails webhook verification however it is scoped.')
      console.log('\n   Fix: grant this key those scopes in the Nango dashboard, or use the key')
      console.log('   that already has them, as NANGO_API_KEY (Vercel + the worker). Webhook')
      console.log('   HMACs are verified with NANGO_WEBHOOK_SIGNING_KEY, a separate value.')
      process.exit(1)
    }
    console.log('\n❌ No configured Nango API key authenticated. Checklist:')
    console.log('   • Use a key from the Nango dashboard that can list integrations, not the public key.')
    console.log('   • Match the ENVIRONMENT: the key and the enabled integrations must be in the same Nango env (Dev vs Prod).')
    console.log('   • EU region? set NANGO_HOST=https://api-eu.nango.dev (currently defaulting to US Cloud).')
    console.log('   • Remove the duplicate key line so the right value is used.')
    process.exit(1)
  }

  console.log(`\n✅ Auth OK. ${configs.length} integration(s) enabled in your Nango environment:\n`)

  const enabledKeys = new Set(configs.map((c) => c.unique_key))
  const matched: string[] = []
  const mismatched: string[] = []
  for (const c of configs) {
    const provider = KEY_TO_PROVIDER.get(c.unique_key)
    if (provider) {
      matched.push(c.unique_key)
      console.log(`   ✅ ${c.unique_key.padEnd(20)} → ${provider} (agent tools wired)`)
    } else {
      mismatched.push(c.unique_key)
      console.log(`   ⚠️  ${c.unique_key.padEnd(20)} → connectable, but NO agent tools (unique_key matches no config key)`)
    }
  }

  // Which supported providers are not enabled at all?
  const missing = Object.entries(PROVIDER_CONFIG_KEYS).filter(
    ([, keys]) => !keys.some((k) => enabledKeys.has(k)),
  )

  console.log('\n── Summary ──────────────────────────────────────────')
  console.log(`   ${matched.length}/${configs.length} enabled integrations map to agent tools`)
  if (mismatched.length) {
    console.log(`   ⚠️  ${mismatched.length} enabled with NO tools: ${mismatched.join(', ')}`)
    console.log('       (rename the dashboard unique_key to the canonical value in docs/nango-setup.md)')
  }
  if (missing.length) {
    console.log(`   ⏳ ${missing.length} supported provider(s) not yet enabled in the dashboard:`)
    console.log(`       ${missing.map(([p, keys]) => `${p} (set unique_key="${keys[0]}")`).join(', ')}`)
  }
  if (!mismatched.length && !missing.length) {
    console.log('   🎉 Every supported provider is enabled and correctly keyed.')
  }

  // Nango never signs webhooks with the API key, so a deployment with only an
  // API key verifies nothing and silently drops every connection event.
  const signing = process.env.NANGO_WEBHOOK_SIGNING_KEY || env.NANGO_WEBHOOK_SIGNING_KEY?.[0] || env.NANGO_SECRET_KEY?.[0]
  console.log(
    signing
      ? '   ✅ A webhook signing key is configured (NANGO_WEBHOOK_SIGNING_KEY).'
      : '   ⚠️  No NANGO_WEBHOOK_SIGNING_KEY — webhook deliveries will fail verification.',
  )
}

main().catch((e) => {
  console.log('❌ Unexpected error:', e?.message ?? e)
  process.exit(1)
})
