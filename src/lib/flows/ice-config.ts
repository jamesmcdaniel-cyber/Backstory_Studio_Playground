import { createHmac } from 'crypto'
import { captureError } from '@/lib/observability/sentry'

export type IceServer = { urls: string | string[]; username?: string; credential?: string }

/**
 * coturn "REST API" ephemeral credentials (use-auth-secret): username is the
 * expiry unix timestamp (optionally suffixed with an identifier for relay
 * attribution), credential is base64(HMAC-SHA1(secret, username)). The relay
 * validates the HMAC and refuses the credential after the timestamp — so a
 * leaked credential dies on its own instead of living as long as a static
 * TURN_CREDENTIAL. Pure: caller supplies the clock.
 */
export const TURN_SECRET_TTL_SECONDS = 86_400

export function turnRestCredentials(
  secret: string,
  nowMs: number,
  options: { ttlSeconds?: number; identifier?: string } = {},
): { username: string; credential: string } {
  const expiry = Math.floor(nowMs / 1000) + (options.ttlSeconds ?? TURN_SECRET_TTL_SECONDS)
  const username = options.identifier ? `${expiry}:${options.identifier}` : String(expiry)
  const credential = createHmac('sha1', secret).update(username).digest('base64')
  return { username, credential }
}

/**
 * WebRTC ICE servers from env. Always Google STUN; a TURN relay entry is
 * appended only when ALL of TURN_URL / TURN_USERNAME / TURN_CREDENTIAL are
 * set (a half-configured relay is worse than none). TURN_URL may be a
 * comma-separated list. Creds are read server-side only — the huddle-ice
 * endpoint hands them to authenticated users at call time, never the bundle.
 */
export function iceServersFromEnv(env: {
  TURN_URL?: string
  TURN_USERNAME?: string
  TURN_CREDENTIAL?: string
}): IceServer[] {
  const servers: IceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]
  const urls = (env.TURN_URL ?? '').split(',').map((u) => u.trim()).filter(Boolean)
  if (urls.length && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    servers.push({ urls: urls.length === 1 ? urls[0] : urls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL })
  }
  return servers
}

/** Which credential tier resolveIceServers landed on. 'stun-only' means no
 *  relay: peers behind strict/symmetric NATs will fail to connect, and the
 *  client uses this to say so instead of showing a bare "connection lost". */
export type IceProvider = 'cloudflare' | 'turn-ephemeral' | 'turn-static' | 'stun-only'

export type IceConfig = { iceServers: IceServer[]; provider: IceProvider }

export type IceEnv = {
  CLOUDFLARE_TURN_KEY_ID?: string
  CLOUDFLARE_TURN_API_TOKEN?: string
  TURN_URL?: string
  TURN_USERNAME?: string
  TURN_CREDENTIAL?: string
  /** Self-hosted coturn shared secret (use-auth-secret) — mints ephemeral creds per call. */
  TURN_SECRET?: string
}

/**
 * Credentials are consumed when a PEER CONNECTION is created, not only at join:
 * someone joining an hour into a huddle mints a connection against config the
 * others fetched earlier. A short TTL would break only late joiners — a
 * confusing failure. A day is still bounded, which is the point of moving off a
 * static secret.
 */
export const CLOUDFLARE_TURN_TTL_SECONDS = 86_400

const CLOUDFLARE_TIMEOUT_MS = 5_000

/** Defensive parse: an entry is usable only if it has string or string[] urls. */
export function parseCloudflareIceServers(body: unknown): IceServer[] | null {
  if (!body || typeof body !== 'object') return null
  const servers = (body as { iceServers?: unknown }).iceServers
  if (!Array.isArray(servers)) return null
  const usable = servers.filter((entry): entry is IceServer => {
    if (!entry || typeof entry !== 'object') return false
    const urls = (entry as { urls?: unknown }).urls
    return typeof urls === 'string' || (Array.isArray(urls) && urls.length > 0)
  })
  return usable.length ? usable : null
}

/**
 * ICE config, best tier first: Cloudflare short-lived credentials → self-hosted
 * coturn ephemeral (TURN_URL + TURN_SECRET) → static TURN_* env → STUN-only.
 * Any Cloudflare failure falls through rather than failing the join, so a
 * relay outage degrades to the previous behaviour instead of breaking the
 * huddle outright.
 */
export async function resolveIceServers(
  env: IceEnv,
  options: { customIdentifier?: string; fetchImpl?: typeof fetch; nowMs?: number } = {},
): Promise<IceConfig> {
  const keyId = env.CLOUDFLARE_TURN_KEY_ID
  const token = env.CLOUDFLARE_TURN_API_TOKEN
  if (keyId && token) {
    try {
      const doFetch = options.fetchImpl ?? fetch
      const response = await doFetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ttl: CLOUDFLARE_TURN_TTL_SECONDS,
            ...(options.customIdentifier ? { customIdentifier: options.customIdentifier } : {}),
          }),
          signal: AbortSignal.timeout(CLOUDFLARE_TIMEOUT_MS),
        },
      )
      if (!response.ok) throw new Error(`Cloudflare TURN responded ${response.status}`)
      const parsed = parseCloudflareIceServers(await response.json())
      if (!parsed) throw new Error('Cloudflare TURN returned no usable iceServers')
      return { iceServers: parsed, provider: 'cloudflare' }
    } catch (error) {
      // Never include the response body — it carries the credential.
      captureError(error, { scope: 'flows.huddle.ice', provider: 'cloudflare' })
    }
  }
  // Self-hosted coturn with a shared secret: ephemeral creds minted here beat
  // the static TURN_USERNAME/TURN_CREDENTIAL pair (which stays as the fallback
  // for relays without use-auth-secret).
  const turnUrls = (env.TURN_URL ?? '').split(',').map((u) => u.trim()).filter(Boolean)
  if (turnUrls.length && env.TURN_SECRET) {
    const { username, credential } = turnRestCredentials(env.TURN_SECRET, options.nowMs ?? Date.now(), {
      identifier: options.customIdentifier,
    })
    return {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls, username, credential },
      ],
      provider: 'turn-ephemeral',
    }
  }
  const iceServers = iceServersFromEnv(env)
  return { iceServers, provider: iceServers.length > 1 ? 'turn-static' : 'stun-only' }
}
