/**
 * Nango outbound delivery adapters.
 *
 * Nango is the delivery arm: agents post to Slack, send Gmail, and write
 * Salesforce records through connected accounts. Delivery prefers the acting
 * user's OWN connection (so a message arrives as the rep) and falls back to an
 * org-level connection.
 *
 * Each adapter goes through Nango's proxy so credentials never touch our
 * process. The proxy is injectable for tests.
 */

import { randomBytes } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { getNangoClient, nangoConfigured } from './client'

export interface DeliveryConnection {
  connectionId: string
  providerConfigKey: string
  scope: 'user' | 'org'
}

/** Provider config keys we treat as delivery targets, by capability. */
export const DELIVERY_PROVIDERS = {
  slack: ['slack'],
  gmail: ['google-mail', 'gmail'],
  salesforce: ['salesforce', 'salesforce-sandbox'],
} as const

export type DeliveryCapability = keyof typeof DELIVERY_PROVIDERS

/**
 * Resolve the connection to use for a capability: the acting user's own
 * connection first, then any org connection. Matches provider config keys for
 * the capability.
 */
export async function resolveDeliveryConnection(
  organizationId: string,
  capability: DeliveryCapability,
  userId?: string | null,
): Promise<DeliveryConnection | null> {
  return resolveNangoConnection(organizationId, DELIVERY_PROVIDERS[capability] as readonly string[], userId)
}

// ── Proxy seam ───────────────────────────────────────────────────────────────

export interface NangoProxyArgs {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  endpoint: string
  connectionId: string
  providerConfigKey: string
  data?: unknown
  params?: Record<string, string | number>
  headers?: Record<string, string>
}

export type NangoProxy = (args: NangoProxyArgs) => Promise<{ data: unknown }>

/**
 * Race a promise against a deadline. Nango's ProxyConfiguration exposes no
 * timeout and its axios layer defaults to none, so a hung upstream (Slack/Gmail/
 * Salesforce not responding) would block a delivery — and therefore an agent
 * run — indefinitely. Racing rejects the caller at the deadline; the dangling
 * request is left to settle and is ignored.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer)) as Promise<T>
}

/** Per-request Nango proxy ceiling, read at call time; env-tunable, default 20s. */
function proxyTimeoutMs(): number {
  const parsed = Math.floor(Number(process.env.NANGO_PROXY_TIMEOUT_MS))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20_000
}

export function defaultProxy(): NangoProxy {
  const nango = getNangoClient()
  return (args) =>
    withTimeout(
      nango.proxy(args as never) as Promise<{ data: unknown }>,
      proxyTimeoutMs(),
      `Nango proxy ${args.method} ${args.endpoint}`,
    )
}

/**
 * Resolve a Nango connection for ANY provider by its config key(s): the acting
 * user's own connection first, then any org connection. This is the generalized
 * form of resolveDeliveryConnection — used by the multi-provider tool registry
 * (provider-tools.ts) so every provider's tools resolve a connection the same
 * way delivery tools do.
 */
export async function resolveNangoConnection(
  organizationId: string,
  providerConfigKeys: readonly string[],
  userId?: string | null,
): Promise<DeliveryConnection | null> {
  const connections = await prisma.nangoConnection.findMany({
    where: { organizationId, providerConfigKey: { in: [...providerConfigKeys] }, status: 'connected' },
  })
  if (connections.length === 0) return null
  const own = userId ? connections.find((connection) => connection.userId === userId) : undefined
  const chosen = own ?? connections.find((connection) => !connection.userId) ?? connections[0]
  return {
    connectionId: chosen.connectionId,
    providerConfigKey: chosen.providerConfigKey,
    scope: chosen.userId === userId && userId ? 'user' : 'org',
  }
}

// ── Adapters ─────────────────────────────────────────────────────────────────

export async function slackPostMessage(
  connection: DeliveryConnection,
  args: { channel: string; text: string },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const response = await proxy({
    method: 'POST',
    endpoint: '/chat.postMessage',
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    data: { channel: args.channel, text: args.text },
  })
  return response.data
}

/**
 * Agents compose report deliverables as HTML (see features/agents/report-format).
 * Same sniff the Resend tool uses, so both send paths agree on what "is HTML".
 */
const LOOKS_HTML = /<[a-z][\s\S]*>/i

/** Headers are single-line: a CR/LF in to/subject would inject arbitrary headers. */
function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

/**
 * RFC 2047 encoded-word. Report subjects carry em-dashes and emoji, which are
 * not legal raw in a header.
 */
function encodeHeader(value: string): string {
  const clean = headerValue(value)
  return /^[\x20-\x7E]*$/.test(clean)
    ? clean
    : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`
}

/**
 * Base64 body, folded at 76 chars. Report markup runs thousands of characters
 * per line; unencoded that breaks the RFC 5322 998-octet line limit and the
 * message gets mangled in transit (dropped markup, breaks mid-token).
 */
function encodeBody(value: string): string {
  return (Buffer.from(value, 'utf8').toString('base64').match(/.{1,76}/g) ?? ['']).join('\r\n')
}

/** Readable fallback for clients that refuse HTML, mirroring the Resend path. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * RFC 5322 message for the Gmail send API. An HTML body goes out as
 * multipart/alternative (plain text first, HTML last — receivers render the
 * last part they understand); a plain body stays a single text/plain part.
 */
export function buildGmailMimeMessage(args: { to: string; subject: string; body: string }): string {
  const headers = [`To: ${headerValue(args.to)}`, `Subject: ${encodeHeader(args.subject)}`, 'MIME-Version: 1.0']

  if (!LOOKS_HTML.test(args.body)) {
    return [
      ...headers,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      encodeBody(args.body),
    ].join('\r\n')
  }

  const boundary = `bs_${randomBytes(16).toString('hex')}`
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodeBody(htmlToText(args.body)),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodeBody(args.body),
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

export async function gmailSendEmail(
  connection: DeliveryConnection,
  args: { to: string; subject: string; body: string },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const raw = Buffer.from(buildGmailMimeMessage(args), 'utf8').toString('base64url')
  const response = await proxy({
    method: 'POST',
    endpoint: '/gmail/v1/users/me/messages/send',
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    data: { raw },
  })
  return response.data
}

export async function salesforceCreateRecord(
  connection: DeliveryConnection,
  args: { sobject: string; fields: Record<string, unknown> },
  proxy: NangoProxy = defaultProxy(),
): Promise<unknown> {
  const response = await proxy({
    method: 'POST',
    endpoint: `/services/data/v60.0/sobjects/${args.sobject}`,
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    data: args.fields,
  })
  return response.data
}

// ── Tool descriptors for the agent runtime ───────────────────────────────────

export interface DeliveryToolSpec {
  capability: DeliveryCapability
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (connection: DeliveryConnection, args: Record<string, unknown>, proxy?: NangoProxy) => Promise<unknown>
}

export const DELIVERY_TOOLS: DeliveryToolSpec[] = [
  {
    capability: 'slack',
    name: 'slack_post_message',
    description: 'Post a message to a Slack channel or user as the connected account.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel id or name (e.g. #revenue) or user id for a DM.' },
        text: { type: 'string', description: 'Message text.' },
      },
      required: ['channel', 'text'],
    },
    run: (connection, args, proxy) =>
      slackPostMessage(connection, { channel: String(args.channel), text: String(args.text) }, proxy),
  },
  {
    capability: 'gmail',
    name: 'gmail_send_email',
    description: 'Send an email from the connected Gmail account.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
    },
    run: (connection, args, proxy) =>
      gmailSendEmail(
        connection,
        { to: String(args.to), subject: String(args.subject), body: String(args.body) },
        proxy,
      ),
  },
  {
    capability: 'salesforce',
    name: 'salesforce_create_record',
    description: 'Create a Salesforce record (e.g. Task, Event) via the connected account.',
    inputSchema: {
      type: 'object',
      properties: {
        sobject: { type: 'string', description: 'SObject API name, e.g. Task.' },
        fields: { type: 'object', description: 'Field name/value map for the new record.' },
      },
      required: ['sobject', 'fields'],
    },
    run: (connection, args, proxy) =>
      salesforceCreateRecord(
        connection,
        { sobject: String(args.sobject), fields: (args.fields as Record<string, unknown>) ?? {} },
        proxy,
      ),
  },
]

export { nangoConfigured }
