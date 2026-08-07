# Voice relay (TURN) setup for huddles

Huddle audio is peer-to-peer WebRTC. Signaling rides the flow's private
Supabase Realtime channel (nothing to configure beyond Realtime being on and
the `flow_jam_rls` migration being deployed), but the audio itself flows
directly between browsers. On open home/office networks STUN is enough; strict
or symmetric NATs — corporate networks and VPNs especially — need a TURN relay
to bounce the audio through, or the two sides never connect.

**Production currently has no TURN configured**, so huddles are STUN-only.
The code resolves ICE servers per join, best tier first
(`src/lib/flows/ice-config.ts`):

1. **Cloudflare TURN** (recommended) — short-lived credentials minted per call,
   relay usage attributed per workspace via `customIdentifier`.
2. Self-hosted coturn with `use-auth-secret` ephemeral credentials.
3. Static TURN credentials.
4. STUN-only (today's state). The huddle panel now warns users when a peer is
   unreachable in this tier.

## Connecting Cloudflare TURN (one-time)

1. Cloudflare dashboard → **Realtime** → **TURN Server** → create a TURN key.
   It yields a **Token ID** and an **API token** (shown once).
2. Set both in Vercel for Production (and Preview if desired):
   - `CLOUDFLARE_TURN_KEY_ID` = the Token ID
   - `CLOUDFLARE_TURN_API_TOKEN` = the API token
   Use `printf 'value' | npx vercel env add NAME production` — an interactive
   paste that ends up empty silently breaks the tier (it falls through to
   STUN-only; the failure is only visible in Sentry under `flows.huddle.ice`).
3. Redeploy. Verify by calling `GET /api/flows/huddle-ice` signed in: the
   response's `provider` should be `"cloudflare"` and `relayAvailable: true`.

Cloudflare's TURN free allowance is 1 TB/month egress; audio-only mesh calls
are a few dozen MB per participant-hour, so cost is negligible at current
scale.

## Alternatives

- coturn: set `TURN_URL` (comma-separated ok) + `TURN_SECRET`
  (use-auth-secret mode; ephemeral creds are minted server-side), or
  `TURN_URL` + `TURN_USERNAME` + `TURN_CREDENTIAL` for static auth.
- All credentials are handed out only by the auth-gated
  `/api/flows/huddle-ice` endpoint at join time — never baked into the bundle.
