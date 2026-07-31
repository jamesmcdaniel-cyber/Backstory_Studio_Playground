import { GRANOLA_BASE_URL, testGranolaApiKey } from './granola'

/**
 * The built-in integrations a workspace supplies its own credential for.
 *
 * These used to read a single platform env var each, which meant every
 * workspace shared one Slack bot, one sending address, one Granola account.
 * Now a customer workspace brings its own; the env value survives only for
 * internal/partner orgs (see org-credential.ts). This module is the registry
 * that makes that self-service: what to call the credential, where it lives in
 * the encrypted blob, and how to prove it works before we store it.
 *
 * A credential is ALWAYS verified against the provider before being saved. A
 * key that doesn't work is worse than no key: the integration looks connected
 * and fails at run time, inside an agent, where the error surfaces as a failed
 * run rather than a settings problem.
 */

export const CREDENTIAL_PROVIDERS = ['slack', 'email', 'granola'] as const
export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number]

export function isCredentialProvider(value: string): value is CredentialProvider {
  return (CREDENTIAL_PROVIDERS as readonly string[]).includes(value)
}

export interface CredentialProviderSpec {
  provider: CredentialProvider
  label: string
  /** What the user is being asked for, in their words. */
  fieldLabel: string
  hint: string
  /** Where to get one. */
  docsUrl: string
}

/**
 * Every provider stores its secret under `apiKey` in the encrypted blob, because
 * that is the only key `buildAuthConfig({ authType: 'api_key' })` encrypts — a
 * differently-named field would be dropped on the floor, silently. The
 * user-facing name lives in `fieldLabel` instead.
 */
export const CREDENTIAL_FIELD = 'apiKey'

export const CREDENTIAL_SPECS: Record<CredentialProvider, CredentialProviderSpec> = {
  slack: {
    provider: 'slack',
    label: 'Slack',
    fieldLabel: 'Bot user OAuth token',
    hint: 'Starts with xoxb-. Needs the chat:write scope, and the bot must be invited to any channel it posts in.',
    docsUrl: 'https://api.slack.com/apps',
  },
  email: {
    provider: 'email',
    label: 'Email (Resend)',
    fieldLabel: 'Resend API key',
    hint: 'Starts with re_. Agents send from your own verified domain, not a shared address.',
    docsUrl: 'https://resend.com/api-keys',
  },
  granola: {
    provider: 'granola',
    label: 'Granola',
    fieldLabel: 'Granola API key',
    hint: 'Starts with grn_. Read-only access to your workspace’s meeting notes.',
    docsUrl: 'https://granola.ai',
  },
}

export interface CredentialCheck {
  ok: boolean
  /** Upstream status, so callers can tell a bad key (401/403) from an outage. */
  status: number | null
}

/** Prove a credential works, using each provider's cheapest identity endpoint. */
export async function verifyCredential(
  provider: CredentialProvider,
  value: string,
): Promise<CredentialCheck> {
  try {
    if (provider === 'slack') {
      // auth.test is the canonical "who am I" call. Slack answers HTTP 200 even
      // for a rejected token, so the body's `ok` is the real result.
      const response = await fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: { Authorization: `Bearer ${value}`, 'Content-Type': 'application/json; charset=utf-8' },
        signal: AbortSignal.timeout(15_000),
      })
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
      // A live token that failed auth is a 401 to the caller, not an outage.
      return { ok: body.ok === true, status: body.ok === true ? 200 : 401 }
    }

    if (provider === 'email') {
      const response = await fetch('https://api.resend.com/domains', {
        method: 'GET',
        headers: { Authorization: `Bearer ${value}` },
        signal: AbortSignal.timeout(15_000),
      })
      return { ok: response.ok, status: response.status }
    }

    return await testGranolaApiKey(value)
  } catch {
    // Network failure — unreachable, not invalid. The caller distinguishes.
    return { ok: false, status: null }
  }
}

/** Base URL a provider's tools talk to, for display. */
export const CREDENTIAL_ENDPOINTS: Record<CredentialProvider, string> = {
  slack: 'https://slack.com/api',
  email: 'https://api.resend.com',
  granola: GRANOLA_BASE_URL,
}
