import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  slackPostMessage,
  gmailSendEmail,
  salesforceCreateRecord,
  DELIVERY_TOOLS,
  type NangoProxyArgs,
} from '../delivery'

const connection = { connectionId: 'conn-1', providerConfigKey: 'slack', scope: 'user' as const }

function recordingProxy() {
  const calls: NangoProxyArgs[] = []
  const proxy = async (args: NangoProxyArgs) => {
    calls.push(args)
    return { data: { ok: true } }
  }
  return { calls, proxy }
}

test('slackPostMessage proxies chat.postMessage with channel + text', async () => {
  const { calls, proxy } = recordingProxy()
  await slackPostMessage(connection, { channel: '#revenue', text: 'hi' }, proxy)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].endpoint, '/chat.postMessage')
  assert.equal(calls[0].connectionId, 'conn-1')
  assert.deepEqual(calls[0].data, { channel: '#revenue', text: 'hi' })
})

test('gmailSendEmail base64url-encodes an RFC822 message', async () => {
  const { calls, proxy } = recordingProxy()
  await gmailSendEmail(
    { connectionId: 'c', providerConfigKey: 'google-mail', scope: 'org' },
    { to: 'a@b.com', subject: 'Hey', body: 'Body' },
    proxy,
  )
  const raw = (calls[0].data as { raw: string }).raw
  const decoded = Buffer.from(raw, 'base64url').toString('utf8')
  assert.match(decoded, /To: a@b\.com/)
  assert.match(decoded, /Subject: Hey/)
  const [headers, body] = decoded.split('\r\n\r\n')
  assert.match(headers, /Content-Transfer-Encoding: base64/)
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'Body')
})

async function sentMessage(body: string, subject = 'Hey'): Promise<string> {
  const { calls, proxy } = recordingProxy()
  await gmailSendEmail(
    { connectionId: 'c', providerConfigKey: 'google-mail', scope: 'org' },
    { to: 'a@b.com', subject, body },
    proxy,
  )
  return Buffer.from((calls[0].data as { raw: string }).raw, 'base64url').toString('utf8')
}

function partBody(message: string, mime: string): string {
  const boundary = /boundary="([^"]+)"/.exec(message)?.[1]
  assert.ok(boundary, 'expected a multipart boundary')
  const part = message
    .split(`--${boundary}`)
    .find((section) => section.includes(`Content-Type: ${mime}`))
  assert.ok(part, `expected a ${mime} part`)
  const encoded = part.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n/g, '').trim()
  return Buffer.from(encoded, 'base64').toString('utf8')
}

test('gmailSendEmail sends an HTML body as text/html, not as literal source', async () => {
  const html = '<div style="color:#475569">Upsell Readiness &amp; Priority Brief</div>'
  const message = await sentMessage(html)
  assert.match(message, /MIME-Version: 1\.0/)
  assert.match(message, /Content-Type: multipart\/alternative; boundary="/)
  assert.equal(partBody(message, 'text/html'), html)
})

test('gmailSendEmail includes a tag-stripped plain-text alternative', async () => {
  const message = await sentMessage('<p>First</p><p>Second &amp; last</p>')
  assert.equal(partBody(message, 'text/plain'), 'First\nSecond & last')
})

test('gmailSendEmail keeps a non-HTML body as a single text/plain part', async () => {
  const message = await sentMessage('Just a plain note')
  assert.match(message, /Content-Type: text\/plain; charset=UTF-8/)
  assert.doesNotMatch(message, /multipart\/alternative/)
  assert.doesNotMatch(message, /text\/html/)
})

test('gmailSendEmail folds long lines under the RFC 5322 998-octet limit', async () => {
  // One <tr> of a report table is easily >998 chars; unencoded it gets mangled
  // in transit, which drops chunks of markup and breaks lines mid-token.
  const row = `<tr>${'<td style="padding:8px 10px;border:1px solid #e5e7eb;">cell</td>'.repeat(60)}</tr>`
  const message = await sentMessage(`<table>${row}</table>`)
  for (const line of message.split('\r\n')) {
    assert.ok(line.length <= 998, `line of ${line.length} octets exceeds the RFC 5322 limit`)
  }
  assert.equal(partBody(message, 'text/html'), `<table>${row}</table>`)
})

test('gmailSendEmail RFC 2047-encodes a non-ASCII subject', async () => {
  const message = await sentMessage('<p>hi</p>', 'Upsell Brief — 20 Accounts 🎉')
  const encoded = /Subject: (.+)\r\n/.exec(message)?.[1] ?? ''
  assert.match(encoded, /^=\?UTF-8\?B\?/)
  assert.equal(
    Buffer.from(encoded.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, ''), 'base64').toString('utf8'),
    'Upsell Brief — 20 Accounts 🎉',
  )
})

test('gmailSendEmail strips header injection attempts from to/subject', async () => {
  const message = await sentMessage('<p>hi</p>', 'Subject\r\nBcc: attacker@evil.com')
  // Folded onto the Subject line, so it is inert text rather than a real header.
  assert.doesNotMatch(message, /^Bcc:/m)
  assert.match(message, /Subject: Subject Bcc: attacker@evil\.com\r\n/)
})

test('salesforceCreateRecord posts to the sobject endpoint', async () => {
  const { calls, proxy } = recordingProxy()
  await salesforceCreateRecord(
    { connectionId: 'c', providerConfigKey: 'salesforce', scope: 'org' },
    { sobject: 'Task', fields: { Subject: 'Follow up' } },
    proxy,
  )
  assert.equal(calls[0].endpoint, '/services/data/v60.0/sobjects/Task')
  assert.deepEqual(calls[0].data, { Subject: 'Follow up' })
})

test('DELIVERY_TOOLS run() dispatches through the adapter with a custom proxy', async () => {
  const { calls, proxy } = recordingProxy()
  const slackTool = DELIVERY_TOOLS.find((tool) => tool.name === 'slack_post_message')!
  await slackTool.run(connection, { channel: 'C1', text: 'yo' }, proxy)
  assert.equal(calls[0].endpoint, '/chat.postMessage')
  // Each delivery tool exposes a JSON schema and a capability.
  for (const tool of DELIVERY_TOOLS) {
    assert.equal(typeof tool.description, 'string')
    assert.equal((tool.inputSchema as { type: string }).type, 'object')
  }
})
