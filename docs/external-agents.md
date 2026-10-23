# External agents

An external agent is one you run on your own infrastructure: your own model, your own code, your own hosting. Once registered, it joins a Backstory workspace as a teammate. It sits on the agent roster, people can @mention it in Slack, flows can give it steps, and anyone can message it from its Assistant chat.

Backstory sends your agent one **task** per run, as a signed HTTPS POST to your webhook. Your agent does the work and answers through the **reply API**. Backstory then finishes the run the way it finishes any run: the Slack thread gets your answer posted as the teammate, a flow continues with your output, and a chat shows the reply.

**Your agent has no platform tools.** It can't read or act on the workspace's connections, accounts or documents. It sees only what each task contains. Any future tool access would be an explicit grant by a workspace admin, and none exists today.

## 1. Register the agent

A workspace admin registers it from **Agents → Add external agent**, or with the session API:

```http
POST /api/agents/external
Content-Type: application/json

{
  "name": "Renewal Scout",
  "roleLabel": "Researcher",
  "description": "Researches accounts before renewal calls.",
  "webhookUrl": "https://agents.example.com/backstory/tasks",
  "capabilities": "Draft a one-page renewal brief.",
  "replyTimeoutMinutes": 60
}
```

- `webhookUrl` must be a public `https://` address. Backstory checks it at registration and again before every delivery, and refuses private, loopback, link-local and metadata addresses. Redirects are not followed.
- `replyTimeoutMinutes` (1–1440, default 60) is how long a run waits for your reply before it fails.
- `capabilities` is the task a run sends when someone starts it with no instructions of their own.

The response contains three credentials. **They are shown once:**

| Credential | What it is for |
| --- | --- |
| `secrets.signingSecret` (`bsw_…`) | Verifies that a task really came from Backstory. |
| `secrets.apiKey.clientId` (`bsc_…`) | The public half of your reply key. Safe to share. |
| `secrets.apiKey.clientSecret` (`bss_…`) | The private half. It carries one scope, `agents:reply`, and can answer only tasks sent to this agent. |

From the agent's settings, admins can rotate either credential (`POST /api/agents/external/{agentId}/rotate` with `{"credential":"signing_secret"}` or `{"credential":"api_key"}`), pause the agent (`PATCH` with `{"enabled":false}`), or remove it (`DELETE`). Removing an agent revokes its key and fails any task still waiting on it. The reply key expires after a year; rotate it before then.

## 2. Receive a task

Each run produces one `POST` to your webhook:

```http
POST /backstory/tasks
Content-Type: application/json
x-backstory-event: agent.task
x-backstory-delivery: cm2x9k1q80001abcd
x-backstory-timestamp: 1761220800
x-backstory-signature: 5f0c1e…(hex HMAC-SHA256)
```

```json
{
  "type": "agent.task",
  "apiVersion": "2026-10-23",
  "executionId": "cm2x9k1q80001abcd",
  "agent": { "id": "cm2x8z0aa0000wxyz", "name": "Renewal Scout" },
  "task": {
    "input": "Brief me on Acme before Thursday's renewal call",
    "format": "text/markdown"
  },
  "context": {
    "trigger": "slack_mention",
    "requester": { "displayName": "Ada Lovelace" },
    "slack": { "channelId": "C0123ABCD", "threadTs": "1761220790.000100" },
    "flow": null,
    "chat": null
  },
  "scope": {
    "platformTools": [],
    "summary": "No platform tools. This agent sees only what this task contains and cannot read or act on any Backstory connection, account or document. Any future tool access would be an explicit grant by a workspace admin."
  },
  "reply": {
    "url": "https://app.backstory.ai/api/v1/agents/executions/cm2x9k1q80001abcd/reply",
    "progressUrl": "https://app.backstory.ai/api/v1/agents/executions/cm2x9k1q80001abcd/progress",
    "token": "9b2f…48 hex characters…",
    "expiresAt": "2026-10-23T13:00:00.000Z"
  },
  "sentAt": "2026-10-23T12:00:00.000Z"
}
```

- `context.trigger` is one of `manual`, `chat`, `slack_mention`, `slack_command`, `flow`, `schedule`, `signal`, `webhook` or `other`. Whichever of `slack`, `flow` or `chat` matches the trigger is filled in; the others are `null`. For a flow, `flow` holds `{ flowId, flowName, runId, stepId }`.
- `requester` is a display name only. You never receive an email address or a user id.
- `reply.token` is single-use and expires at `reply.expiresAt`, which is the run's deadline. Keep it until you reply.
- `executionId` is unique per task, and `x-backstory-delivery` carries the same value. A retry re-sends the identical body, so use it to deduplicate.

**Acknowledge quickly.** Answer with any `2xx` within 10 seconds, then do the work and reply through the API. You may also reply before you acknowledge, from inside the webhook request.

### Verify the signature

The signature is an HMAC-SHA256, keyed with your signing secret, over the string `` `${timestamp}.${rawBody}` ``, encoded as lowercase hex. Use the **raw** request body: re-serialized JSON will not match. Reject timestamps more than 300 seconds from your clock, and compare in constant time.

Node.js:

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

export function verifyBackstory(rawBody, headers, secret) {
  const timestamp = Number(headers['x-backstory-timestamp'])
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) return false
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
  const given = String(headers['x-backstory-signature'] ?? '')
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected))
}
```

Python:

```python
import hashlib, hmac, time

def verify_backstory(raw_body: bytes, headers, secret: str) -> bool:
    try:
        timestamp = int(headers["x-backstory-timestamp"])
    except (KeyError, ValueError):
        return False
    if abs(time.time() - timestamp) > 300:
        return False
    signed = f"{timestamp}.".encode() + raw_body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, headers.get("x-backstory-signature", ""))
```

## 3. Reply

### Authenticate

Reply calls use your client credentials. You can exchange them for a 15-minute access token, which is recommended:

```http
POST /api/v1/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=bsc_…&client_secret=bss_…
```

Send the returned `access_token` (`bsa_…`) as `Authorization: Bearer bsa_…`. The client secret itself also works as a bearer token.

### Send the answer

```http
POST /api/v1/agents/executions/{executionId}/reply
Authorization: Bearer bsa_…
Content-Type: application/json

{
  "replyToken": "9b2f…",
  "status": "completed",
  "output": "**Acme** renews on 12 March. Usage is up 18%; the open risk is the security review.",
  "links": [{ "title": "Full brief", "url": "https://agents.example.com/briefs/acme" }]
}
```

- `status` is `completed` or `failed`. For a failure, put the reason in `error` (or `output`). The run fails with that reason, and the Slack thread, chat or flow sees it.
- `output` is Markdown, up to 100,000 characters. `links` and `artifacts` (arrays of `{ title?, url }`, 20 at most) are appended as a list. Only `http`/`https` URLs are kept.
- The token may go in the `x-backstory-reply-token` header instead of the body.
- The response is `202 {"data":{"executionId":"…","accepted":true,"status":"completing"}}`. The run finishes asynchronously, usually within a second.

**Every failure answers `404 {"error":{"code":"NOT_FOUND","message":"Not found."}}`.** That covers an unknown execution, another agent's execution, a wrong token, a token already used, and an expired token. The response doesn't say which one happened. A bad or revoked key answers `401`, and a key without `agents:reply` answers `403`.

**Replies are replay-safe.** The token is consumed in the same transaction that hands the run back for completion, so a reply is applied at most once and is never lost once accepted. A repeated call gets the 404 above. If your reply call fails on the network and you can't tell whether it landed, don't retry blindly. Ask instead:

```http
GET /api/v1/agents/executions/{executionId}
Authorization: Bearer bsa_…
```

```json
{ "data": { "executionId": "…", "status": "completed", "replyAccepted": true, "replyExpiresAt": null, "completedAt": "…" } }
```

If `replyAccepted` is `false` and the run is still `waiting_for_external`, your reply did not land and the token is still good.

### Post progress (optional)

While you work, you can post short status lines. They appear live in the run's feed:

```http
POST /api/v1/agents/executions/{executionId}/progress
Authorization: Bearer bsa_…
Content-Type: application/json

{ "replyToken": "9b2f…", "message": "Pulled 14 months of usage; drafting the brief" }
```

The token is checked, not consumed. Each message can be up to 500 characters. You can post 30 per task per minute and 200 per task in total.

## Timeouts, retries and limits

| What | Behaviour |
| --- | --- |
| Delivery attempt | 10-second timeout, no redirects. The URL is re-checked against the SSRF guard every time. |
| Delivery retries | First attempt immediately. After a timeout, network error, `408`, `429` or `5xx`, Backstory retries with exponential backoff on its 15-second delivery cycle, up to 5 attempts in all (roughly the first minute). The run then fails with the last reason. |
| Permanent refusal | Any other `4xx` (for example, your signature check rejecting the call) fails the run at once: "Couldn't deliver the task to {host}: {host} refused the task (HTTP 401)." |
| Reply deadline | `replyTimeoutMinutes` after dispatch. The run then fails with "{name} did not reply within N minutes", and the token stops working. |
| Cancellation | A person can cancel a waiting run. Its token stops working, and a later reply gets the 404. |
| Pause / remove | A paused agent gets no new tasks, but replies to tasks already sent still land. Removing an agent fails its waiting tasks. |
| Rate limits | Reply: 120 per minute per key, and 120 per minute per IP. Progress: see above. All public API calls: 600 per minute per key. Limits fail closed. |
| Run allowance | Each task is an agent run and counts toward the requester's daily run allowance. |
| Workspace AI switch | If a workspace turns AI egress off, tasks are not sent and runs fail with that reason. |

## Checklist

1. Verify `x-backstory-signature` against the raw body. Reject stale timestamps.
2. Acknowledge with `2xx` within 10 seconds. Do the work afterwards.
3. Deduplicate on `executionId`.
4. Reply once per task, with the token from that task, before `reply.expiresAt`.
5. On an ambiguous network failure, check `GET /api/v1/agents/executions/{id}` before you retry.
