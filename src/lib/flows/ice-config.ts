import { captureError } from '@/lib/observability/sentry'

export type IceServer = { urls: string | string[]; username?: string; credential?: string }

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

export type IceEnv = {
  CLOUDFLARE_TURN_KEY_ID?: string
  CLOUDFLARE_TURN_API_TOKEN?: string
  TURN_URL?: string
  TURN_USERNAME?: string
  TURN_CREDENTIAL?: string
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
 * ICE config, best tier first: Cloudflare short-lived credentials → static
 * TURN_* env → STUN-only. Any Cloudflare failure falls through rather than
 * failing the join, so a relay outage degrades to the previous behaviour
 * instead of breaking the huddle outright.
 */
export async function resolveIceServers(
  env: IceEnv,
  options: { customIdentifier?: string; fetchImpl?: typeof fetch } = {},
): Promise<IceServer[]> {
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
      return parsed
    } catch (error) {
      // Never include the response body — it carries the credential.
      captureError(error, { scope: 'flows.huddle.ice', provider: 'cloudflare' })
    }
  }
  return iceServersFromEnv(env)
}
