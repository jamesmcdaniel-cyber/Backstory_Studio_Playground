# Voice huddle runbook — TURN relay and verification

The flow voice huddle is a P2P WebRTC audio mesh. Most connections go direct
over STUN. A minority — symmetric NAT, restrictive corporate firewalls — need a
TURN relay to connect at all. **Until the Cloudflare vars below are set, those
users cannot join a huddle**, and there is no in-app symptom other than the
call never connecting.

## One-time: enable the relay

1. In the Cloudflare dashboard, open **Realtime → TURN** and create a TURN key.
   Note the **key ID** and the **API token**. The token is a secret; it is read
   only server-side and never reaches the client bundle.
2. Set both in Vercel (Production, Preview, and Development as desired):

   ```
   CLOUDFLARE_TURN_KEY_ID=<key id>
   CLOUDFLARE_TURN_API_TOKEN=<api token>
   ```

   Watch the known Vercel gotcha: an empty value silently creates the variable
   as an empty string, which reads as "set" to `process.env` but fails at
   Cloudflare. Paste the values, do not leave either blank.
3. Redeploy. No code change is needed — `resolveIceServers` picks the vars up at
   call time (`src/lib/flows/ice-config.ts`).

Nothing else needs configuring. With the vars absent the app is not broken; it
falls back to the static `TURN_*` vars if those exist, and then to STUN-only.

## Verify the relay actually carries media

A green test suite proves none of this. The tests cover policy — when to retry,
what copy to send — not whether audio flows. Only this check does.

1. Two machines, two accounts, same flow. **One of them must be on a
   restrictive network** (corporate wifi, or a phone hotspot with the laptop
   VPN'd). Two machines on the same home wifi will connect directly and will
   never exercise the relay, so the check would pass while proving nothing.
2. Both join the huddle.
3. On the constrained machine open `chrome://webrtc-internals`, find the active
   peer connection, and look at the **selected candidate pair**. Its type must
   read `relay`. `host` or `srflx` means the connection went direct — valid, but
   it did not test what you came to test.
4. Confirm audio is audible both directions.

If the pair never reaches `relay` on a network you expect to require it, check
the Network tab for `GET /api/flows/huddle-ice` and confirm the response
contains a `turn:` entry with a `username`. An `iceServers` array holding only
`stun:` means the vars did not reach the runtime.

## Verify connection recovery

1. With a huddle live, disable wifi on one machine for about 3 seconds, then
   re-enable it.
2. That participant's avatar in the huddle bar should dim and pulse
   ("reconnecting"), then return to normal.
3. Audio must resume **without** either side leaving and rejoining. That is the
   whole point of the change — previously a blip closed the peer permanently.
4. Leave wifi off for ~30s to confirm the other path: after two failed ICE
   restarts the avatar goes grey ("connection lost") rather than hanging.

## Verify microphone failure messaging

In a fresh browser profile, deny the microphone prompt when joining. The huddle
bar must appear carrying the message "Microphone access is blocked" with a hint
pointing at the address bar, and **no Retry button** — browsers do not re-prompt
after a hard deny, so a retry control would silently do nothing.

## Verify huddle awareness

1. Two profiles on one flow. Start a huddle in A. B toasts once ("A started a
   huddle") with a working **Join** action.
2. A third participant joins. B does **not** toast again — one toast per huddle,
   not one per joiner.
3. Reload B while the huddle is still live. B does **not** toast (the page seeds
   its presence ref on first snapshot), but the huddle bar is visible.
4. From A's jam dialog while in the huddle, ring B. B's notification bell shows
   huddle copy, and web push fires if VAPID keys are configured.
5. With no huddle live, send an ordinary jam invite and confirm the copy is
   unchanged from before this feature existed.

## Known limitations

- **Mesh size.** One peer connection per participant. Fine at 2–5, degrades past
  ~6. Larger rooms need an SFU, which is not built.
- **Ringing is editor-only.** The invite endpoint is gated on `flow.write`, so a
  view-only participant in a huddle cannot ring anyone.
- **A huddle nobody rings stays invisible** to people without the flow open.
- **No sound on the huddle-start toast.** Browsers block audio without a prior
  gesture on the page.
