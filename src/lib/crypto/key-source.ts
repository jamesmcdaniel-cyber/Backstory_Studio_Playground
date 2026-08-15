/**
 * Where ENCRYPTION_KEY material comes from.
 *
 * The key was read straight from `process.env.ENCRYPTION_KEY`. That satisfies
 * "keys separated from the encrypted values" — the ciphertext is in Postgres,
 * the key is in Vercel's environment, and a database dump alone is useless —
 * but it does not satisfy "stored in an approved secrets manager". The key sat
 * in plaintext in a platform env var, readable by anyone with project access
 * and by any code running in the process, with no access log and no way to
 * revoke a single reader.
 *
 * This module puts a real secrets manager underneath without changing how
 * encryption works. The v2 key-id envelope, the decryption ring, and the
 * rotation script are all untouched: KMS supplies the MATERIAL, and everything
 * downstream still just sees keys.
 *
 * ── Why the key is fetched once at boot and then held in memory ────────────
 *
 * encryptSecret/decryptSecret are synchronous and called on hot paths — every
 * flow step that touches a credential, every MCP tool call. Making them async
 * would be a repo-wide refactor AND would put a network round trip inside every
 * credential read, turning a secrets-manager outage into a total outage.
 *
 * So the key is resolved once during server instrumentation and cached in
 * process memory. That is the standard envelope pattern: the KMS protects the
 * key at rest and controls who may fetch it, and the running process holds the
 * derived material for as long as it lives. A rotation takes effect on the next
 * deploy, or immediately via refreshKeyMaterial().
 *
 * ── Providers ─────────────────────────────────────────────────────────────
 *
 *   env     — the previous behaviour. Still the default, because forcing a KMS
 *             on local development and CI would mean neither could run.
 *   vault   — HashiCorp Vault KV v2 over its HTTP API. No SDK dependency.
 *   aws-kms — an ENCRYPTED data key in env, decrypted at boot by AWS KMS. The
 *             env var then holds ciphertext that is useless without KMS access,
 *             which is the actual improvement over a plaintext key.
 */

import { apiLogger } from '@/lib/logger'

export type KeySourceProvider = 'env' | 'vault' | 'aws-kms'

export interface KeyMaterial {
  /** The active key new writes are encrypted under. */
  primary: string
  /** Retired keys still needed to read existing ciphertext. */
  previous: string[]
  provider: KeySourceProvider
}

let cached: KeyMaterial | null = null

export function configuredProvider(): KeySourceProvider {
  const raw = (process.env.ENCRYPTION_KEY_PROVIDER ?? 'env').trim().toLowerCase()
  if (raw === 'vault' || raw === 'aws-kms' || raw === 'env') return raw
  throw new Error(
    `Unknown ENCRYPTION_KEY_PROVIDER "${raw}". Expected one of: env, vault, aws-kms.`,
  )
}

/**
 * Material resolved at boot, or null when initialization has not run.
 *
 * secrets.ts falls back to reading process.env directly when this is null, so
 * unit tests and scripts that never boot the server keep working unchanged.
 */
export function cachedKeyMaterial(): KeyMaterial | null {
  return cached
}

/**
 * Resolve key material from the configured provider and cache it.
 *
 * Called from instrumentation.ts before anything can encrypt. Throws in
 * production when a non-env provider is configured but unreachable: booting a
 * server that cannot decrypt its own credentials would turn every integration
 * into a silent, confusing failure, and "refuse to start" is the honest signal.
 */
export async function initializeKeyMaterial(): Promise<KeyMaterial> {
  const provider = configuredProvider()

  try {
    const material =
      provider === 'vault'
        ? await loadFromVault()
        : provider === 'aws-kms'
          ? await loadFromAwsKms()
          : loadFromEnv()

    if (!material.primary) {
      throw new Error(`Key provider "${provider}" returned no primary key.`)
    }

    cached = material
    // The key id, never the key. Being able to answer "which key is this
    // deployment writing with" during a rotation is the entire reason the v2
    // envelope carries an id at all.
    apiLogger.info('encryption key material loaded', {
      provider,
      retiredKeys: material.previous.length,
    })
    return material
  } catch (error) {
    if (provider !== 'env') {
      throw new Error(
        `Could not load encryption key material from "${provider}": ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
    }
    throw error
  }
}

/** Re-fetch after a rotation, without a redeploy. */
export async function refreshKeyMaterial(): Promise<KeyMaterial> {
  cached = null
  return initializeKeyMaterial()
}

/** Test seam — drops the cached material so the env fallback applies again. */
export function __resetKeyMaterialForTests(): void {
  cached = null
}

// ── Providers ──────────────────────────────────────────────────────────────

function loadFromEnv(): KeyMaterial {
  return {
    primary: process.env.ENCRYPTION_KEY ?? '',
    previous: splitPrevious(process.env.ENCRYPTION_KEY_PREVIOUS),
    provider: 'env',
  }
}

/**
 * HashiCorp Vault, KV v2, over the HTTP API — deliberately no SDK. Vault's read
 * API is one authenticated GET, and a dependency here would have to be
 * installed, audited and kept current in every deployment that does not use
 * Vault at all.
 *
 * Expects a secret with a `key` field, and optionally `previous` (a
 * comma-separated list) so a rotation can be staged entirely inside Vault.
 */
async function loadFromVault(): Promise<KeyMaterial> {
  const address = requireEnv('VAULT_ADDR')
  const token = requireEnv('VAULT_TOKEN')
  const path = requireEnv('VAULT_ENCRYPTION_KEY_PATH')

  const url = new URL(path.replace(/^\/+/, ''), address.endsWith('/') ? address : `${address}/`)
  const response = await fetch(url, {
    headers: { 'X-Vault-Token': token, accept: 'application/json' },
    // A hung secrets manager must not hang the boot indefinitely.
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    // Vault's body can echo request context; the status is the actionable part
    // and is safe to surface.
    throw new Error(`Vault returned HTTP ${response.status} for ${path}`)
  }

  const body = (await response.json()) as { data?: { data?: Record<string, unknown> } }
  const data = body.data?.data ?? {}
  const primary = typeof data.key === 'string' ? data.key : ''
  const previous = typeof data.previous === 'string' ? splitPrevious(data.previous) : []

  return { primary, previous, provider: 'vault' }
}

/**
 * AWS KMS envelope decryption.
 *
 * ENCRYPTION_KEY_CIPHERTEXT holds a base64 KMS-encrypted data key. The env var
 * is therefore useless on its own — reading the platform environment no longer
 * hands someone every credential in the database, which is the whole point of
 * moving off a plaintext env key.
 *
 * The SDK is imported dynamically so deployments not using KMS need not install
 * it, and a missing package produces an actionable message rather than a module
 * resolution error at boot.
 */
async function loadFromAwsKms(): Promise<KeyMaterial> {
  const ciphertext = requireEnv('ENCRYPTION_KEY_CIPHERTEXT')

  let KMSClient: new (config: Record<string, unknown>) => { send(command: unknown): Promise<unknown> }
  let DecryptCommand: new (input: Record<string, unknown>) => unknown
  try {
    // Assembled at runtime so TypeScript and the bundler do not try to resolve
    // a package that deployments without KMS have no reason to install.
    const moduleName = ['@aws-sdk', 'client-kms'].join('/')
    const sdk = (await import(/* webpackIgnore: true */ moduleName)) as unknown as {
      KMSClient: typeof KMSClient
      DecryptCommand: typeof DecryptCommand
    }
    KMSClient = sdk.KMSClient
    DecryptCommand = sdk.DecryptCommand
  } catch {
    throw new Error(
      'ENCRYPTION_KEY_PROVIDER=aws-kms requires the @aws-sdk/client-kms package. ' +
        'Install it, or switch the provider.',
    )
  }

  const client = new KMSClient({ region: process.env.AWS_REGION })
  const result = (await client.send(
    new DecryptCommand({
      CiphertextBlob: Buffer.from(ciphertext, 'base64'),
      ...(process.env.ENCRYPTION_KMS_KEY_ID ? { KeyId: process.env.ENCRYPTION_KMS_KEY_ID } : {}),
    }),
  )) as { Plaintext?: Uint8Array }

  if (!result.Plaintext) throw new Error('KMS returned no plaintext for the data key.')

  const previousCiphertexts = splitPrevious(process.env.ENCRYPTION_KEY_PREVIOUS_CIPHERTEXT)
  const previous: string[] = []
  for (const blob of previousCiphertexts) {
    const decrypted = (await client.send(
      new DecryptCommand({ CiphertextBlob: Buffer.from(blob, 'base64') }),
    )) as { Plaintext?: Uint8Array }
    if (decrypted.Plaintext) previous.push(Buffer.from(decrypted.Plaintext).toString('utf8'))
  }

  return {
    primary: Buffer.from(result.Plaintext).toString('utf8'),
    previous,
    provider: 'aws-kms',
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required for this encryption key provider.`)
  return value
}

export function splitPrevious(raw: string | undefined | null): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}
