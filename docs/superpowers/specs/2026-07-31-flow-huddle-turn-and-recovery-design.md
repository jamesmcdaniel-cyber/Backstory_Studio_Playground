# Flow Huddle v2 — Cloudflare TURN and Connection Recovery

**Date:** 2026-07-31
**Status:** Approved (design) — pending implementation plan
**Owner:** James McDaniel
**Predecessors:**
- `2026-07-16-flows-jam-realtime-multiplayer-design.md` — the jam transport
- `2026-07-16-jam-gaps-turn-fieldmerge-sharelinks-design.md` — built the
  env-configured ICE endpoint and explicitly deferred the provider choice
  ("pick a provider … no code change"). This spec makes that choice.

## Problem

The voice huddle shipped at 532f95c and works: an audio-only WebRTC mesh over
the private `flow:<id>` Realtime topic, with a pure signaling reducer
(`huddle-signals.ts`), a floating bar, mute, and a speaking pulse. Two gaps
keep it from being dependable.

1. **No relay is configured.** `iceServersFromEnv` appends a TURN entry only
   when all three `TURN_*` vars are set. They are not set, so every huddle is
   STUN-only, and users behind symmetric NAT or restrictive corporate firewalls
   simply cannot connect. The code path exists; the provider was never picked.
2. **Failures are silent.** A denied microphone is swallowed at
   `use-flow-huddle.ts:143` — the user clicks Join and nothing visibly happens.
   And a peer entering `disconnected` is torn down immediately at
   `use-flow-huddle.ts:85`, even though `disconnected` is frequently transient
   (a wifi blip, a network switch). A two-second glitch permanently kills that
   peer's audio until both sides leave and rejoin.

Both failures are invisible to the user, which makes the feature feel broken
rather than degraded.

## Decisions

| Area | Decision | Why |
|---|---|---|
| Relay provider | **Cloudflare Realtime TURN** | Cheapest per GB for a fallback-only, audio-only path; mints short-lived credentials; no always-on server to operate. |
| Credential model | **Short-lived, minted server-side per join** | No permanent shared secret in env; credentials expire on their own. |
| Provider failure | **Fall through to static env, then STUN** | A relay outage degrades to today's behavior; the huddle never fails to start because Cloudflare is unreachable. |
| Transient drops | **Grace period, then ICE restart, then close** | `disconnected` usually recovers; tearing down on it is the bug. |
| Signaling protocol | **Unchanged** | An ICE-restart offer is an offer to a known peer, which `reduceHuddleSignal` already routes correctly. |

## Section 1 — Cloudflare TURN

### Credential generation

`POST https://rtc.live.cloudflare.com/v1/turn/keys/$KEY_ID/credentials/generate-ice-servers`
with `Authorization: Bearer $API_TOKEN` and body `{ ttl, customIdentifier }`.
The response body's `iceServers` array is already the exact shape
`useFlowHuddle` parses at `use-flow-huddle.ts:132` — STUN and TURN entries with
`urls` / `username` / `credential`. **The client requires no change.**

`customIdentifier` is set to the **organization id**, so Cloudflare aggregates
relay usage per workspace. That gives per-workspace cost attribution and a
lever if one workspace ever generates anomalous traffic.

`ttl` is **86400** (24h). Credentials are consumed at *peer-connection* time,
not only at join time: someone joining a huddle two hours in mints a connection
against config fetched earlier. A short TTL would produce a confusing failure
mode where only late joiners break. A day-long credential is still bounded,
which is the property that motivated moving off a static secret.

### Resolution order

`ice-config.ts` grows a resolver tried in order:

1. **Cloudflare** — when `CLOUDFLARE_TURN_KEY_ID` and
   `CLOUDFLARE_TURN_API_TOKEN` are both set.
2. **Static `TURN_*` env** — the existing `iceServersFromEnv`, unchanged, so
   any provider can be swapped in without code.
3. **STUN-only** — today's behavior.

A Cloudflare call that fails or times out falls through to tier 2 and reports
to Sentry. Partial configuration never produces a half-configured relay.

The HTTP call is an injectable seam (a `fetch`-shaped parameter) so precedence
and response parsing are unit-testable without network access.

### Endpoint

`GET /api/flows/huddle-ice` keeps its `withAuthenticatedApi` wrapper and
`flow.read` permission, and keeps returning `{ success: true, iceServers }`.
It gains the caller's org id to pass as `customIdentifier`.

### Client change

`join()` drops the mount-lifetime `iceServersRef` cache and **fetches per
join**. Join is a rare, deliberate user gesture, so the extra request is
immaterial, and credentials cannot go stale in a long-lived tab. This restores
what the predecessor spec specified ("fetches the endpoint once per join").
Servers fetched at join are still reused for peers created later in that same
huddle, which the 24h TTL comfortably covers.

## Section 2 — Surfacing and recovering from failures

### Microphone denial

A new pure module `media-errors.ts` exports `describeMediaError(err)` returning
`{ title, hint, retryable }`:

- `NotAllowedError` → "Microphone access is blocked", hint pointing at the
  address-bar permission control, **`retryable: false`**. Browsers do not
  re-prompt after a hard deny, so a retry button would silently do nothing —
  worse than no button.
- `NotFoundError` / `OverconstrainedError` → "No microphone found", retryable
  (a device can be plugged in).
- Anything else → generic message, retryable.

`useFlowHuddle` exposes `error: MediaErrorInfo | null`, set in the existing
`catch` at `join()` and cleared on the next join attempt. `HuddleBar` renders
it as an inline row with the hint, and a Retry button only when `retryable`.

### Peer recovery

A new pure module `peer-recovery.ts` exports a reducer:

```
nextPeerAction(state: RTCPeerConnectionState, attempts: number, isInitiator: boolean)
  → 'wait' | 'restart-ice' | 'close'
```

Policy:

- `connected` → clears any pending recovery.
- `disconnected` → `'wait'`. A grace timer (**5s**) runs; recovery to
  `connected` cancels it.
- Grace expiry or `failed` → `'restart-ice'` for the peer that originally
  created the offer (`isInitiator`), `'wait'` for the answerer. Reusing the
  existing deterministic-initiator rule means both sides never restart at once,
  the same way `reduceHuddleSignal` avoids offer glare today.
- After **2** attempts (backoff 1s, 4s) → `'close'`.
- `closed` → `'close'`.

`PeerEntry` gains `isInitiator`, `attempts`, and a grace-timer handle. The
restart itself is `pc.restartIce()` followed by a fresh offer sent over the
existing `huddle` bus — and because `huddle-signals.ts:37` applies an incoming
offer to an existing connection when one is present, **the signaling reducer
needs no change**.

### Visible state

`useFlowHuddle` exposes `peerStates: Map<clientId, 'connected' | 'reconnecting' | 'lost'>`.
`HuddleBar` dims a reconnecting member's avatar and overlays a spinner; a lost
peer's avatar is dimmed without the pulse. A drop becomes visible instead of
silent.

## Files

| File | Change |
|---|---|
| `src/lib/flows/ice-config.ts` | Cloudflare fetch + three-tier resolver; `iceServersFromEnv` kept |
| `src/app/api/flows/huddle-ice/route.ts` | Call the resolver; pass org id |
| `src/lib/flows/media-errors.ts` | **New** — pure `describeMediaError` |
| `src/lib/flows/peer-recovery.ts` | **New** — pure `nextPeerAction` |
| `src/lib/flows/use-flow-huddle.ts` | Per-join fetch; `error`; `peerStates`; grace timer + ICE restart |
| `src/components/flows/huddle-bar.tsx` | Error row; per-peer connection state |
| `src/lib/flows/__tests__/ice-config.test.ts` | Extend: precedence, parsing, failure fallthrough |
| `src/lib/flows/__tests__/media-errors.test.ts` | **New** |
| `src/lib/flows/__tests__/peer-recovery.test.ts` | **New** |

Both new modules follow the `huddle-signals.ts` pattern already established
here: policy is a pure function, WebRTC side effects stay in the hook. That is
what makes them testable without a browser.

## Testing

- **Unit (pure):** resolver precedence including partial and failed config;
  Cloudflare response parsing; every `describeMediaError` branch; the recovery
  reducer across states, attempt counts, and both initiator roles.
- **Integration:** the existing `support/fake-realtime.ts` harness covers that a
  restart offer reaches the peer and is applied to the existing connection
  rather than creating a second one.
- **Manual, and required before calling this done:** two machines, one behind a
  restrictive network, confirming a relayed connection establishes (verify via
  `chrome://webrtc-internals` that the selected candidate pair is `relay`).
  Then kill wifi on one for ~3s and confirm audio recovers without rejoining.

That last item cannot be automated here — it needs a real Cloudflare account
and a genuinely hostile network. The design fails safe (STUN-only keeps
working), but "the relay actually rescues the connection" is only ever proven
by running it.

## Rollout

1. Create a Cloudflare Realtime TURN key; set `CLOUDFLARE_TURN_KEY_ID` and
   `CLOUDFLARE_TURN_API_TOKEN` in Vercel.
2. Deploy. With the vars unset, behavior is identical to today, so the code can
   ship before the account exists.
3. Run the manual verification above.

## Out of scope (follow-ons)

Named here so they are not lost, in rough priority order:

1. **Huddle-start notification** — teammates only discover a huddle if the flow
   is already open.
2. **Push-to-talk** and **input/output device pickers**.
3. **Per-peer volume and local mute.**
4. **SFU migration** — the mesh is fine at 2–5 and degrades past ~6 (n²
   connections). Only worth it if larger rooms become a real requirement.
5. **Huddle transcript feeding the flow copilot** — the differentiating one:
   the copilot hearing "add a retry after the Slack step" and acting on it.
6. **Server-side credential caching** per org for the TTL, if join volume ever
   makes the Cloudflare call worth avoiding.
